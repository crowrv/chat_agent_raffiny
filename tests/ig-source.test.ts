import { describe, expect, test } from "bun:test";
import { applyInboxRows, isExpectedReviewHub, type Row, type State } from "../src/ig-source";

describe("Instagram source state handling", () => {
  test("does not advance preview state when delivery fails", async () => {
    const state: State = { previews: { Jane: "old message" } };
    const row: Row = { name: "Jane", preview: "new message · now" };

    const changed = await applyInboxRows(state, [row], false, async () => false);

    expect(changed).toBe(false);
    expect(state.previews.Jane).toBe("old message");
  });

  test("advances preview state after successful delivery", async () => {
    const state: State = { previews: { Jane: "old message" } };
    const row: Row = { name: "Jane", preview: "new message · now" };

    const changed = await applyInboxRows(state, [row], false, async () => true);

    expect(changed).toBe(true);
    expect(state.previews.Jane).toBe("new message");
  });

  test("first run records a baseline without delivering rows", async () => {
    const state: State = { previews: {} };
    let deliveries = 0;

    const changed = await applyInboxRows(
      state,
      [{ name: "Jane", preview: "existing message · now" }],
      true,
      async () => {
        deliveries += 1;
        return true;
      },
    );

    expect(changed).toBe(true);
    expect(deliveries).toBe(0);
    expect(state.previews.Jane).toBe("existing message");
  });
});

describe("Instagram source hub health validation", () => {
  test("requires matching instance, project root, and review role", () => {
    expect(isExpectedReviewHub(
      { instance: "local-dev", projectRoot: "/repo", roles: { review: true } },
      "local-dev",
      "/repo",
    )).toBe(true);

    expect(isExpectedReviewHub(
      { instance: "local-dev", projectRoot: "/other", roles: { review: true } },
      "local-dev",
      "/repo",
    )).toBe(false);

    expect(isExpectedReviewHub(
      { instance: "local-dev", projectRoot: "/repo", roles: { review: false } },
      "local-dev",
      "/repo",
    )).toBe(false);
  });
});
