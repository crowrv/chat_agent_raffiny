import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(path).text();

describe("operation scripts", () => {
  test("hub startup is conservative and does not enable Instagram polling by default", async () => {
    const hub = await read("hub.sh");

    expect(hub).toContain('IG_SOURCE="${IG_SOURCE:-0}"');
    expect(hub).toContain("start-ig");
    expect(hub).toContain("stop-ig");
    expect(hub).toContain("restart-ig");
    expect(hub).toContain("status-ig");
    expect(hub.match(/stop\(\) \{[\s\S]*?\n\}/)?.[0]).not.toContain("stop_ig_source");
    expect(hub).not.toContain('pkill -f "src/hub.ts"');
    expect(hub).not.toContain('pkill -f "src/ig-source.ts"');
    expect(hub).toContain("process_matches");
    expect(hub).toContain("find_owned_pids");
    expect(hub).toContain("process_cwd_matches");
    expect(hub).toContain("owned_pids");
    expect(hub).toContain("hub_health_matches");
    expect(hub).toContain("hub_review_ready");
    expect(hub).toContain("wait_for_hub_health");
    expect(hub).toContain("EXPECTED_HUB_ID");
    expect(hub).toContain("projectRoot");
    expect(hub).toContain('ps -p "$pid" -ww -o command=');
    expect(hub).toContain('HUB_PORT="${TELEGRAM_HUB_PORT:-4713}"');
    expect(hub).not.toContain("http://127.0.0.1:4713/");
  });

  test("starting a foreground Claude session does not implicitly start Instagram polling", async () => {
    const run = await read("run.sh");

    expect(run).toContain("IG_SOURCE=0 ./hub.sh start");
  });

  test("fleet script owns review, ops, and Instagram lifecycle commands", async () => {
    const fleet = await read("fleet.sh");

    for (const command of [
      "start-review",
      "start-ops",
      "restart-review",
      "restart-ops",
      "start-ig",
      "stop-ig",
      "restart-ig",
      "status-ig",
    ]) {
      expect(fleet).toContain(command);
    }
    expect(fleet.match(/stop_all\(\) \{[\s\S]*?\n\}/)?.[0]).toContain("./hub.sh stop-ig");
    expect(fleet.match(/start_hub\(\) \{[\s\S]*?\n\}/)?.[0]).toContain("IG_SOURCE=0 ./hub.sh start");
    expect(fleet.match(/start_ig\(\) \{[\s\S]*?\n\}/)?.[0]).toContain("wait_for_review");
    expect(fleet.match(/restart_ig\(\) \{[\s\S]*?\n\}/)?.[0]).not.toContain("./hub.sh restart-ig");
    expect(fleet).toContain("process.argv.slice(1)");
    expect(fleet).toContain("expectedInstance");
    expect(fleet).toContain("projectRoot");
  });
});
