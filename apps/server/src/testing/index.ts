/**
 * `@vl/server/testing` — test doubles that are shared across workspaces.
 *
 * Only doubles another workspace's *tests* need are published here. T15's fault
 * matrix drills the real `TokenManager` and `OAuthClient` against a loopback
 * token endpoint (spec §11: "OAuth access-token 만료, refresh-token 철회"), and
 * this repository already has that endpoint — duplicating it in `tools/soak`
 * would be a second fake of the same protocol that could drift from T3's.
 *
 * Nothing in `apps/server/src/main.ts` imports this path, and everything it
 * hands out is an obviously synthetic value (CLAUDE.md §3).
 */
export {
  FakeOAuthServer,
  type FakeOAuthServerOptions,
  type FakeTokenRequest,
  type TokenScenario,
} from './fake-oauth-server.js'
