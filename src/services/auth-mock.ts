// auth-mock —— 仅本地开发用。localhost 收不到 .cqu.moe 跨子域 cookie。
// 只有 DEV_AUTH_MOCK=1 且 localhost 时才会被注入（见 src/index.ts），
// 生产环境 `env.AUTH` service binding 存在故不会用到此 mock。
import type { AuthService, VerifiedSession, GetCquTicketResult } from "./auth-rpc";

export function createMockAuth(): AuthService {
  const session: VerifiedSession = {
    user: {
      id: "devuser000000000000000000000000",
      name: "开发者",
      email: "dev@cqu.moe",
      role: "user",
    },
    caps: {
      calendar: {
        sync: true,
        external: true,
        share: true,
        change_notification: true,
        sub_limit: 10,
        share_limit: 20,
        sync_interval: 60,
        manual_refresh: 20,
      },
    },
  };
  return {
    async verifySession() {
      return session;
    },
    async getCquTicket(): Promise<GetCquTicketResult> {
      return { error: "DEV_NO_TICKET" };
    },
    async getCaps() {
      return session.caps;
    },
  };
}
