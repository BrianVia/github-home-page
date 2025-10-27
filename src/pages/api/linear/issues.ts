import type { APIRoute } from "astro";

type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  status: {
    name: string;
    type: string;
    color: string;
  };
  priority: {
    value: number;
    name: string;
  } | null;
  project: {
    name: string;
    icon: string | null;
    color: string;
  } | null;
  assignee: {
    name: string;
    avatarUrl: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  team: {
    name: string;
    key: string;
  };
};

export const GET: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime as any;
  const env = runtime?.env || import.meta.env;

  const LINEAR_TOKEN = env.LINEAR_TOKEN;
  if (!LINEAR_TOKEN) {
    return new Response(JSON.stringify({ error: "Missing LINEAR_TOKEN" }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }

  const ttl = Number(env.LINEAR_CACHE_TTL || "90");
  const cacheKey = "linear:recent-issues";

  // Try cache if available (Cloudflare KV)
  if (runtime?.env?.GH_CACHE) {
    const cached = await runtime.env.GH_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: {
          "content-type": "application/json",
          "x-cache": "HIT"
        }
      });
    }
  }

  // Linear GraphQL query for recent issues (excluding Done and Canceled)
  const query = `
    query RecentIssues($first: Int!) {
      issues(
        first: $first
        orderBy: updatedAt
        filter: {
          and: [
            {
              or: [
                { assignee: { isMe: { eq: true } } }
                { creator: { isMe: { eq: true } } }
              ]
            }
            {
              state: {
                type: { nin: ["completed", "canceled"] }
              }
            }
          ]
        }
      ) {
        nodes {
          id
          identifier
          title
          url
          createdAt
          updatedAt
          priority
          state {
            name
            type
            color
          }
          project {
            name
            icon
            color
          }
          assignee {
            name
            avatarUrl
          }
          team {
            name
            key
          }
        }
      }
    }
  `;

  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": LINEAR_TOKEN
      },
      body: JSON.stringify({
        query,
        variables: { first: 20 }
      })
    });

    if (!response.ok) {
      throw new Error(`Linear API error: ${response.status}`);
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(`Linear GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    const issues: LinearIssue[] = result.data.issues.nodes.map((issue: any) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      status: {
        name: issue.state.name,
        type: issue.state.type,
        color: issue.state.color
      },
      priority: issue.priority !== undefined && issue.priority !== null ? {
        value: issue.priority,
        name: ["No priority", "Urgent", "High", "Normal", "Low"][issue.priority] || "Unknown"
      } : null,
      project: issue.project ? {
        name: issue.project.name,
        icon: issue.project.icon,
        color: issue.project.color
      } : null,
      assignee: issue.assignee ? {
        name: issue.assignee.name,
        avatarUrl: issue.assignee.avatarUrl
      } : null,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      team: {
        name: issue.team.name,
        key: issue.team.key
      }
    }));

    // Sort by priority (1=Urgent, 2=High, 3=Normal, 4=Low, 0=No priority goes last), then by updatedAt
    issues.sort((a, b) => {
      const aPriority = a.priority?.value ?? 999;
      const bPriority = b.priority?.value ?? 999;

      // Treat 0 (No priority) as lowest priority
      const aSort = aPriority === 0 ? 999 : aPriority;
      const bSort = bPriority === 0 ? 999 : bPriority;

      if (aSort !== bSort) {
        return aSort - bSort;
      }

      // If same priority, sort by most recently updated
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    const data = {
      generatedAt: new Date().toISOString(),
      issues
    };

    const jsonData = JSON.stringify(data);

    // Cache if available
    if (runtime?.env?.GH_CACHE) {
      await runtime.env.GH_CACHE.put(cacheKey, jsonData, { expirationTtl: ttl });
    }

    return new Response(jsonData, {
      headers: {
        "content-type": "application/json",
        "x-cache": "MISS"
      }
    });
  } catch (error) {
    console.error("Linear API error:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to fetch Linear issues",
        details: error instanceof Error ? error.message : String(error)
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" }
      }
    );
  }
};
