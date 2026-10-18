import { clip, objectSchema, str, type Connector, type ConnectorContext } from "../types.js";
import { apiJson, clientIdSetting } from "./http.js";

const self = { id: "linear", name: "Linear" };

const graphql = (ctx: ConnectorContext, query: string, variables: Record<string, unknown>) =>
  apiJson(ctx, self, "https://api.linear.app/graphql", { method: "POST", json: { query, variables } });

export function linearConnector(): Connector {
  return {
    ...self,
    description: "Search issues and file new ones in Linear.",
    icon: "issue",
    status: "skeleton",
    auth: {
      type: "oauth2-pkce",
      authorizeUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      scopes: ["read", "issues:create"],
    },
    settings: [clientIdSetting],
    actions: [
      {
        name: "search_issues",
        description: "Search issues by text.",
        inputSchema: objectSchema({ query: { type: "string", minLength: 1 } }, ["query"]),
        effects: { readOnly: true },
        summarize: (i) => `Search Linear for "${clip(str(i.query))}"`,
        async run(input, ctx) {
          const r = await graphql(
            ctx,
            "query($term: String!) { searchIssues(term: $term, first: 10) { nodes { identifier title url } } }",
            { term: str(input.query) },
          );
          const nodes =
            (r.data as { searchIssues?: { nodes?: Array<{ identifier: string; title: string; url: string }> } })
              ?.searchIssues?.nodes ?? [];
          return nodes.length ? nodes.map((n) => `${n.identifier} ${n.title} ${n.url}`).join("\n") : "No issues found.";
        },
      },
      {
        name: "create_issue",
        description: "Create an issue in a team (team id).",
        inputSchema: objectSchema(
          {
            teamId: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            description: { type: "string" },
          },
          ["teamId", "title"],
        ),
        effects: { modifies: true },
        verb: "Save",
        fields: {
          teamId: { label: "Team" },
          title: { label: "Title" },
          description: { label: "Description", type: "longtext" },
        },
        summarize: (i) => `New Linear issue "${clip(str(i.title))}"`,
        async run(input, ctx) {
          const r = await graphql(
            ctx,
            "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
            {
              input: {
                teamId: str(input.teamId),
                title: str(input.title),
                description: str(input.description) || undefined,
              },
            },
          );
          const issue = (r.data as { issueCreate?: { issue?: { identifier: string; url: string } } })?.issueCreate
            ?.issue;
          return issue ? `Created ${issue.identifier} ${issue.url}` : "Linear did not confirm the issue.";
        },
      },
    ],
  };
}
