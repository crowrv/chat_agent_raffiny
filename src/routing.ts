export type RaffinSessionRole = "review" | "ops";

export type ChannelWireEvent = {
  platform: "telegram" | "instagram";
  chat_id: string;
  chat_type: string;
  chat_title?: string;
  message_thread_id?: string;
  conversation_id: string;
  message_id: string;
  content: string;
  created_timestamp: number;
  is_dm: boolean;
  mentions_bot: boolean;
  is_command: boolean;
  user_id: string;
  user_name: string;
  user_display_name: string;
  user_is_bot: boolean;
};

export type RoutingConfig = {
  reviewChatId?: string;
  opsChatId?: string;
  includeFallback?: boolean;
};

export type RoutingTarget =
  | { kind: "role"; role: RaffinSessionRole; label: string }
  | { kind: "chat"; chatId: string; label: string }
  | { kind: "fallback"; label: string };

export function parseRaffinSessionRole(value: string | undefined): RaffinSessionRole | undefined {
  if (value === "review" || value === "ops") return value;
  return undefined;
}

export function validateRoutingConfig(config: RoutingConfig): string | undefined {
  const reviewChatId = clean(config.reviewChatId);
  const opsChatId = clean(config.opsChatId);
  if (reviewChatId && opsChatId && reviewChatId === opsChatId) {
    return "RAFFIN_REVIEW_TELEGRAM_CHAT_ID and RAFFIN_OPS_TELEGRAM_CHAT_ID must be different";
  }
  return undefined;
}

export function routingCandidates(
  event: ChannelWireEvent,
  config: RoutingConfig,
): RoutingTarget[] {
  const targets: RoutingTarget[] = [];
  const includeFallback = config.includeFallback ?? true;
  const reviewChatId = clean(config.reviewChatId);
  const opsChatId = clean(config.opsChatId);

  const addRole = (role: RaffinSessionRole) => {
    targets.push({ kind: "role", role, label: `role:${role}` });
  };
  const addChat = (chatId: string, label = `chat:${chatId}`) => {
    targets.push({ kind: "chat", chatId, label });
  };
  const addFallback = () => {
    if (includeFallback) targets.push({ kind: "fallback", label: "fallback" });
  };

  // Instagram customer DMs are deliberately review-only: they must never land in
  // the fallback session, which would bypass the baker-review invariant (drafts
  // approved before anything is sent). If no review session is bound the hub
  // reports the event unrouted so the feeder retries instead of leaking it.
  if (event.platform === "instagram") {
    addRole("review");
    return targets;
  }

  // Role-targeted Telegram chats prefer their role session, then a dedicated chat
  // session, then the fallback session as a last resort so an operator/baker
  // message is never silently dropped while the role session is down.
  if (reviewChatId && event.chat_id === reviewChatId) {
    addRole("review");
    addChat(event.chat_id);
    addFallback();
    return targets;
  }

  if (opsChatId && event.chat_id === opsChatId) {
    addRole("ops");
    addChat(event.chat_id);
    addFallback();
    return targets;
  }

  addChat(event.chat_id);
  addFallback();
  return targets;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
