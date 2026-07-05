import { describe, expect, test } from "bun:test";
import { routingCandidates, validateRoutingConfig, type ChannelWireEvent } from "../src/routing";

const baseEvent: ChannelWireEvent = {
  platform: "telegram",
  chat_id: "chat-other",
  chat_type: "private",
  conversation_id: "telegram:chat:chat-other",
  message_id: "m1",
  content: "hello",
  created_timestamp: 1,
  is_dm: true,
  mentions_bot: true,
  is_command: false,
  user_id: "u1",
  user_name: "isaac",
  user_display_name: "Isaac",
  user_is_bot: false,
};

const config = {
  reviewChatId: "review-chat",
  opsChatId: "ops-chat",
};

describe("routingCandidates", () => {
  test("routes Instagram customer DMs to the review role first", () => {
    const event: ChannelWireEvent = {
      ...baseEvent,
      platform: "instagram",
      chat_id: "customer-name",
      conversation_id: "instagram:thread:customer-name",
    };

    expect(routingCandidates(event, config)).toEqual([
      { kind: "role", role: "review", label: "role:review" },
    ]);
  });

  test("routes Telegram review chat to the review role first", () => {
    const event = {
      ...baseEvent,
      chat_id: "review-chat",
      conversation_id: "telegram:chat:review-chat",
    };

    expect(routingCandidates(event, config)).toEqual([
      { kind: "role", role: "review", label: "role:review" },
      { kind: "chat", chatId: "review-chat", label: "chat:review-chat" },
      { kind: "fallback", label: "fallback" },
    ]);
  });

  test("routes Telegram ops chat to the ops role first", () => {
    const event = {
      ...baseEvent,
      chat_id: "ops-chat",
      conversation_id: "telegram:chat:ops-chat",
    };

    expect(routingCandidates(event, config)).toEqual([
      { kind: "role", role: "ops", label: "role:ops" },
      { kind: "chat", chatId: "ops-chat", label: "chat:ops-chat" },
      { kind: "fallback", label: "fallback" },
    ]);
  });

  test("omits fallback for a role chat when includeFallback is false", () => {
    const event = {
      ...baseEvent,
      chat_id: "review-chat",
      conversation_id: "telegram:chat:review-chat",
    };

    expect(routingCandidates(event, { ...config, includeFallback: false })).toEqual([
      { kind: "role", role: "review", label: "role:review" },
      { kind: "chat", chatId: "review-chat", label: "chat:review-chat" },
    ]);
  });

  test("keeps legacy dedicated chat routing for other Telegram chats", () => {
    expect(routingCandidates(baseEvent, config)).toEqual([
      { kind: "chat", chatId: "chat-other", label: "chat:chat-other" },
      { kind: "fallback", label: "fallback" },
    ]);
  });

  test("routes Instagram only to the review role even without a review chat id", () => {
    const event: ChannelWireEvent = {
      ...baseEvent,
      platform: "instagram",
      chat_id: "customer-name",
      conversation_id: "instagram:thread:customer-name",
    };

    expect(routingCandidates(event, { opsChatId: "ops-chat" })).toEqual([
      { kind: "role", role: "review", label: "role:review" },
    ]);
  });

  test("rejects using the same Telegram chat for review and ops roles", () => {
    expect(validateRoutingConfig({ reviewChatId: "same-chat", opsChatId: "same-chat" }))
      .toContain("must be different");
  });
});
