// Storage layer: reads a full snapshot of the vault and writes changes as one commit.
import fs from "node:fs/promises";
import path from "node:path";

export interface FileChange {
  path: string;
  content: string | null; // null deletes the file
}

export interface CommitInfo {
  message: string;
  date: string;
}

export interface Snapshot {
  head: string;
  files: Map<string, string>;
  recent: CommitInfo[];
}

export interface Store {
  snapshot(): Promise<Snapshot>;
  // Returns the new commit sha, or null when `parent` is no longer the branch head.
  commit(parent: string, changes: FileChange[], message: string): Promise<string | null>;
}

// Re-reads the vault and rebuilds the change set if someone else committed in between.
export async function writeWithRetry(
  store: Store,
  build: (snap: Snapshot) => { changes: FileChange[]; message: string; result: string },
): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const snap = await store.snapshot();
    const { changes, message, result } = build(snap);
    const sha = await store.commit(snap.head, changes, message);
    if (sha) return result;
  }
  throw new Error("הכתיבה נכשלה: הכספת השתנתה שוב ושוב בזמן הכתיבה. נסה שוב.");
}

// ---------- GitHub ----------

const BLOB_BATCH = 80; // blobs per GraphQL request

// Blob contents never change for a given sha, so warm instances reuse them.
const blobCache = new Map<string, string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitHubStore implements Store {
  constructor(
    private token: string,
    private owner: string,
    private repo: string,
    private branch: string,
  ) {}

  static fromEnv(): GitHubStore {
    const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = process.env;
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
      throw new Error("Missing GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO environment variables");
    }
    return new GitHubStore(GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH || "main");
  }

  private async api(method: string, url: string, body?: unknown): Promise<Response> {
    return fetch(url.startsWith("https://") ? url : `https://api.github.com${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async json<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.api(method, url, body);
    if (!res.ok) throw new Error(`GitHub ${method} ${url} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  // GitHub occasionally answers 5xx or a GraphQL "Something went wrong"; retry those.
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= 3) throw e;
        await sleep(300 * 2 ** attempt);
      }
    }
  }

  // Fetches blob texts by sha, many per GraphQL request.
  private async fetchBlobs(shas: string[]): Promise<void> {
    const missing = shas.filter((s) => !blobCache.has(s));
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += BLOB_BATCH) batches.push(missing.slice(i, i + BLOB_BATCH));
    await Promise.all(
      batches.map((batch) =>
        this.retry(async () => {
          const fields = batch.map((sha, i) => `b${i}: object(oid: "${sha}") { ... on Blob { text isTruncated } }`);
          const data = await this.json<any>("POST", "https://api.github.com/graphql", {
            query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`,
            variables: { owner: this.owner, name: this.repo },
          });
          if (data.errors) throw new Error(`GitHub GraphQL error: ${JSON.stringify(data.errors)}`);
          for (const [i, sha] of batch.entries()) {
            const blob = data.data.repository[`b${i}`];
            if (blob && !blob.isTruncated) blobCache.set(sha, blob.text ?? "");
          }
        }),
      ),
    );
    // Large files come back truncated from GraphQL; read those through REST.
    await Promise.all(
      missing
        .filter((s) => !blobCache.has(s))
        .map((sha) =>
          this.retry(async () => {
            const blob = await this.json<{ content: string }>("GET", `/repos/${this.owner}/${this.repo}/git/blobs/${sha}`);
            blobCache.set(sha, Buffer.from(blob.content, "base64").toString("utf8"));
          }),
        ),
    );
  }

  async snapshot(): Promise<Snapshot> {
    const repo = `/repos/${this.owner}/${this.repo}`;
    const commits = await this.retry(() =>
      this.json<{ sha: string; commit: { message: string; committer: { date: string } } }[]>(
        "GET",
        `${repo}/commits?sha=${encodeURIComponent(this.branch)}&per_page=10`,
      ),
    );
    if (!commits.length) throw new Error(`Branch ${this.branch} has no commits in ${this.owner}/${this.repo}`);
    const head = commits[0].sha;

    const tree = await this.retry(() =>
      this.json<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(
        "GET",
        `${repo}/git/trees/${head}?recursive=1`,
      ),
    );
    if (tree.truncated) throw new Error("The vault is too large for a single GitHub tree listing");
    const blobs = tree.tree.filter(
      (e) => e.type === "blob" && e.path.endsWith(".md") && !e.path.startsWith(".obsidian/"),
    );
    await this.fetchBlobs(blobs.map((b) => b.sha));

    const files = new Map(blobs.map((b) => [b.path, blobCache.get(b.sha)!] as [string, string]));
    const recent = commits.map((c) => ({ message: c.commit.message.split("\n")[0], date: c.commit.committer.date }));
    return { head, files, recent };
  }

  async commit(parent: string, changes: FileChange[], message: string): Promise<string | null> {
    const base = `/repos/${this.owner}/${this.repo}/git`;
    const parentCommit = await this.json<{ tree: { sha: string } }>("GET", `${base}/commits/${parent}`);
    const tree = await this.json<{ sha: string }>("POST", `${base}/trees`, {
      base_tree: parentCommit.tree.sha,
      tree: changes.map((c) =>
        c.content === null
          ? { path: c.path, mode: "100644", type: "blob", sha: null }
          : { path: c.path, mode: "100644", type: "blob", content: c.content },
      ),
    });
    const commit = await this.json<{ sha: string }>("POST", `${base}/commits`, {
      message,
      tree: tree.sha,
      parents: [parent],
    });
    const res = await this.api("PATCH", `${base}/refs/heads/${this.branch}`, { sha: commit.sha, force: false });
    if (res.status === 422) return null; // not a fast-forward: branch moved
    if (!res.ok) throw new Error(`GitHub ref update failed: ${res.status} ${await res.text()}`);
    return commit.sha;
  }
}

// ---------- Local folder (tests only) ----------

export class FsStore implements Store {
  head = "0";
  log: { message: string; changes: FileChange[] }[] = [];

  constructor(private root: string) {}

  async snapshot(): Promise<Snapshot> {
    const files = new Map<string, string>();
    const walk = async (dir: string, prefix: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.name === ".git" || e.name === ".obsidian") continue;
        if (e.isDirectory()) await walk(path.join(dir, e.name), prefix + e.name + "/");
        else if (e.name.endsWith(".md")) files.set(prefix + e.name, await fs.readFile(path.join(dir, e.name), "utf8"));
      }
    };
    await walk(this.root, "");
    const recent = this.log.slice(-10).reverse().map((c) => ({ message: c.message, date: new Date().toISOString() }));
    return { head: this.head, files, recent };
  }

  async commit(parent: string, changes: FileChange[], message: string): Promise<string | null> {
    if (parent !== this.head) return null;
    for (const c of changes) {
      const p = path.join(this.root, c.path);
      if (c.content === null) await fs.rm(p, { force: true });
      else {
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, c.content, "utf8");
      }
    }
    this.log.push({ message, changes });
    this.head = String(Number(this.head) + 1);
    return this.head;
  }
}
