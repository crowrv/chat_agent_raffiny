import { describe, expect, test } from "bun:test";
import { telegramIntegerId } from "../src/telegram-ids";

describe("telegramIntegerId", () => {
  test("keeps numeric Telegram ids", () => {
    expect(telegramIntegerId("12345")).toBe(12345);
  });

  test("rejects synthetic Instagram message ids", () => {
    expect(telegramIntegerId("instagram-12345")).toBeUndefined();
  });

  test("rejects unsafe integer ids", () => {
    expect(telegramIntegerId("9007199254740993")).toBeUndefined();
  });
});
