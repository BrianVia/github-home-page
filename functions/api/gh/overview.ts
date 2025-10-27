import { Octokit } from "octokit";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";

interface Env {
  GITHUB_TOKEN: string;
  GH_QUERY_ORGS?: string;
  GH_PINNED_REPOS?: string;
  GH_CACHE?: KVNamespace;
  GH_CACHE_TTL?: string;
}

const MyOctokit = Octokit.plugin(retry, throttling);

type PRBasic = {
  id: string;
  number: number;
  title: string;
  url: string;
  repo: { owner: string; name: string; url: string };
  author: { login: string; avatarUrl: string; url: string } | null;
  updatedAt: string;
  createdAt: string;
  isDraft: boolean;
  labels: { name: string; color: string }[];
  headSha: string | null;
  status: {
    rollup:
      | "SUCCESS"
      | "FAILURE"
      | "PENDING"
      | "ERROR"
      | "EXPECTED"
      | "ACTION_REQUIRED"
      | "TIMED_OUT"
      | null;
    checks: Array<{
      kind: "CheckRun" | "StatusContext";
      name: string;
      status?: string | null;
      conclusion?: string | null;
      state?: string | null;
      detailsUrl?: string | null;
      targetUrl?: string | null;
    }>;
  };
  jobs?: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    started_at: string | null;
    html_url: string;
  }>;
};

function okJSON(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
    status: init.status ?? 200
  });
}

export const onRequest: PagesFunction<Env> = async ({ env, request }) => {
  if (!env.GITHUB_TOKEN) return new Response("Missing GITHUB_TOKEN", { status: 500 });

  const scopeOrgs = (env.GH_QUERY_ORGS || "").split(",").map(s => s.trim()).filter(Boolean);
  const ttl = Number(env.GH_CACHE_TTL || "90");
  const cacheKey = `overview:${scopeOrgs.join(",") || "all"}`;

  if (env.GH_CACHE) {
    const cached = await env.GH_CACHE.get(cacheKey);
    if (cached) return okJSON(JSON.parse(cached), { headers: { "x-cache": "HIT" } });
  }

  const octokit = new MyOctokit({
    auth: env.GITHUB_TOKEN,
    request: { fetch: fetch as any },
    throttle: { onRateLimit: () => true, onSecondaryRateLimit: () => true }
  });

  const buildQueries = (org?: string) => {
    const orgFilter = org ? ` org:${org}` : "";
    return {
      mine: `is:pr is:open author:@me sort:updated-desc${orgFilter}`,
      review: `is:pr is:open review-requested:@me sort:updated-desc${orgFilter}`,
      assigned: `is:pr is:open assignee:@me sort:updated-desc${orgFilter}`
    };
  };

  const gql = `
    query SearchPRs($q: String!, $n: Int!) {
      search(query: $q, type: ISSUE, first: $n) {
        nodes {
          ... on PullRequest {
            id number title url createdAt updatedAt isDraft
            repository { name url owner { login } }
            author { login url avatarUrl }
            labels(first: 10){ nodes { name color } }
            commits(last: 1) {
              nodes {
                commit {
                  oid
                  statusCheckRollup {
                    state
                    contexts(first: 20) {
                      nodes {
                        __typename
                        ... on CheckRun { name status conclusion detailsUrl }
                        ... on StatusContext { context state targetUrl }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`;

  async function fetchBucket(q: string): Promise<PRBasic[]> {
    const res = await octokit.graphql<{ search: { nodes: any[] } }>(gql, { q, n: 20 });
    return (res.search.nodes ?? []).map(pr => {
      const commit = pr.commits?.nodes?.[0]?.commit ?? null;
      const roll = commit?.statusCheckRollup ?? null;
      const contexts = roll?.contexts?.nodes ?? [];
      return {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        repo: { owner: pr.repository.owner.login, name: pr.repository.name, url: pr.repository.url },
        author: pr.author ? { login: pr.author.login, url: pr.author.url, avatarUrl: pr.author.avatarUrl } : null,
        updatedAt: pr.updatedAt,
        createdAt: pr.createdAt,
        isDraft: pr.isDraft,
        labels: (pr.labels?.nodes ?? []).map((l: any) => ({ name: l.name, color: l.color })),
        headSha: commit?.oid ?? null,
        status: {
          rollup: roll?.state ?? null,
          checks: contexts.map((c: any) =>
            c.__typename === "CheckRun"
              ? { kind: "CheckRun", name: c.name, status: c.status, conclusion: c.conclusion, detailsUrl: c.detailsUrl }
              : { kind: "StatusContext", name: c.context, state: c.state, targetUrl: c.targetUrl }
          )
        }
      } as PRBasic;
    });
  }

  // Fetch PRs for each org separately and combine
  const orgsToQuery = scopeOrgs.length > 0 ? scopeOrgs : [undefined];

  const allResults = await Promise.all(
    orgsToQuery.map(async (org) => {
      const queries = buildQueries(org);
      const [mine, review, assigned] = await Promise.all([
        fetchBucket(queries.mine),
        fetchBucket(queries.review),
        fetchBucket(queries.assigned)
      ]);
      return { mine, review, assigned };
    })
  );

  // Combine and deduplicate results from all orgs
  const mine = Array.from(new Map(allResults.flatMap(r => r.mine).map(pr => [pr.id, pr])).values());
  const review = Array.from(new Map(allResults.flatMap(r => r.review).map(pr => [pr.id, pr])).values());
  const assigned = Array.from(new Map(allResults.flatMap(r => r.assigned).map(pr => [pr.id, pr])).values());

  const running = [...mine, ...review, ...assigned].filter(p => p.status.rollup === "PENDING").slice(0, 8);

  async function attachJobs(pr: PRBasic) {
    if (!pr.headSha) return;
    const { owner, name } = pr.repo;
    const runs = await octokit.paginate(octokit.rest.actions.listWorkflowRunsForRepo, {
      owner, repo: name, per_page: 50, event: "pull_request"
    });
    const run = runs.find(r =>
      r.head_sha === pr.headSha ||
      (Array.isArray((r as any).pull_requests) && (r as any).pull_requests.some((x: any) => x.number === pr.number))
    );
    if (!run) return;
    const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
      owner, repo: name, run_id: run.id, filter: "latest", per_page: 100
    });
    pr.jobs = jobs.map(j => ({
      name: j.name, status: j.status ?? "queued", conclusion: j.conclusion ?? null,
      started_at: j.started_at ?? null, html_url: j.html_url
    }));
  }

  await Promise.all(running.map(attachJobs));

  const data = { generatedAt: new Date().toISOString(), scopeOrgs, buckets: { review, mine, assigned } };
  if (env.GH_CACHE) await env.GH_CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: ttl });
  return okJSON(data, { headers: { "x-cache": "MISS" } });
};
