export interface RouteMeta {
  title: string;
  description: string;
  noindex?: boolean;
}

const SITE_NAME = "CQU Schedule";
export const BASE_URL = "https://schedule.cqu.moe";

export const ROUTE_META: Record<string, RouteMeta> = {
  "/": {
    title: `重庆大学课表订阅 | ${SITE_NAME}`,
    description:
      "自动同步重庆大学课表到你的日历应用，支持 Apple 日历、Google Calendar、Outlook 等主流客户端",
  },
  "/api-docs": {
    title: `API 文档 | ${SITE_NAME}`,
    description: "CQU Schedule REST API 文档，ICS 日历订阅接口说明",
  },
  "/login": {
    title: `登录 | ${SITE_NAME}`,
    description: "登录 CQU Schedule 管理你的课表订阅",
    noindex: true,
  },
  "/register": {
    title: `注册 | ${SITE_NAME}`,
    description: "注册 CQU Schedule 开始同步课表",
    noindex: true,
  },
  "/recover": {
    title: `找回 Token | ${SITE_NAME}`,
    description: "找回你的 CQU Schedule 订阅 Token",
    noindex: true,
  },
  "/changelog": {
    title: `更新日志 | ${SITE_NAME}`,
    description: "CQU Schedule 功能更新与改进记录",
  },
};

export const DEFAULT_META: RouteMeta = {
  title: `重庆大学课表订阅 | ${SITE_NAME}`,
  description:
    "自动同步重庆大学课表到你的日历应用，支持 Apple 日历、Google Calendar、Outlook 等主流客户端",
  noindex: true,
};

export function getRouteMeta(pathname: string): RouteMeta {
  return ROUTE_META[pathname] ?? DEFAULT_META;
}
