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

const TREE_DEPTH = 4; // פרויקטים/<project>/שיחות/<file>.md

function treeFragment(depth: number): string {
  const blob = "... on Blob { oid text isTruncated }";
  if (depth === 0) return `entries { name type object { ${blob} } }`;
  return `entries { name type object { ${blob} ... on Tree { ${treeFragment(depth - 1)} } } }`;
}

const SNAPSHOT_QUERY = `query($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) {
      target {
        ... on Commit {
          oid
          history(first: 10) { nodes { message committedDate } }
          tree { ${treeFragment(TREE_DEPTH - 1)} }
        }
      }
    }
  }
}`;

interface GqlEntry {
  name: string;
  type: string;
  object: { oid?: string; text?: string | null; isTruncated?: boolean; entries?: GqlEntry[] } | null;
}

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

  async snapshot(): Promise<Snapshot> {
    const data = await this.json<any>("POST", "https://api.github.com/graphql", {
      query: SNAPSHOT_QUERY,
      variables: { owner: this.owner, name: this.repo, ref: `refs/heads/${this.branch}` },
    });
    if (data.errors) throw new Error(`GitHub GraphQL error: ${JSON.stringify(data.errors)}`);
    const target = data.data?.repository?.ref?.target;
    if (!target) throw new Error(`Branch ${this.branch} not found in ${this.owner}/${this.repo}`);

    const files = new Map<string, string>();
    const truncated: { path: string; oid: string }[] = [];
    const walk = (entries: GqlEntry[], prefix: string) => {
      for (const e of entries) {
        const p = prefix + e.name;
        if (e.type === "tree" && e.object?.entries) {
          if (e.name !== ".obsidian" && e.name !== ".git") walk(e.object.entries, p + "/");
        } else if (e.type === "blob" && e.name.endsWith(".md") && e.object) {
          if (e.object.isTruncated && e.object.oid) truncated.push({ path: p, oid: e.object.oid });
          else files.set(p, e.object.text ?? "");
        }
      }
    };
    walk(target.tree.entries, "");

    await Promise.all(
      truncated.map(async ({ path: p, oid }) => {
        const blob = await this.json<{ content: string }>("GET", `/repos/${this.owner}/${this.repo}/git/blobs/${oid}`);
        files.set(p, Buffer.from(blob.content, "base64").toString("utf8"));
      }),
    );

    const recent = (target.history.nodes as { message: string; committedDate: string }[]).map((n) => ({
      message: n.message.split("\n")[0],
      date: n.committedDate,
    }));
    return { head: target.oid, files, recent };
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
