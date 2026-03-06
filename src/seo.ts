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
