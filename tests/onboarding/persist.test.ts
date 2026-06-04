// Contract test for `persistOnboardingUpdates` (src/onboarding/prisma-deps.ts).
//
// The route layer (src/twilio/routes.ts) calls this adapter for every
// inbound that advances the onboarding state machine. The routes.test.ts
// integration suite uses a fake `stats.upsert` / `preferences.upsert`
// that *ignores* its arguments — so the adapter's actual payloads,
// branch behavior, and call order have been structurally invisible to
// the suite. This file pins them directly.
//
// Invariants pinned here:
//   1. The base case writes `{ onboardingStep: nextStep }` to user.update
//      with no stats / preferences upsert.
//   2. `markActive: true` overrides the cursor, setting status=ACTIVE and
//      onboardingStep=null. The order in the source matters: nextStep is
//      assigned first then overwritten, so the final patch must contain
//      `onboardingStep: null` even when nextStep is "done".
//   3. `displayName` and `campusEmailDomain` use a strict `!== undefined`
//      check, so an explicit `null` would persist (not skip). Today's
//      OnboardingUpdates type only allows `string` for these fields, but
//      the runtime guard still matters: an empty string would persist.
//   4. Stats / Preferences upserts are *skipped* when the input is either
//      absent OR an empty object. This is the only thing preventing
//      accidental `{}` upserts (which Prisma would reject at runtime
//      because the create payload requires `userId`).
//   5. The Stats / Preferences upsert payload puts `userId` in `create`
//      ONLY, not `update`. Dropping the `userId` from create — or
//      sneaking it into update — would either break first-write or
//      tickle Prisma's "cannot update unique" rejections.
//   6. Call order is user → stats → preferences. Reversing it would
//      change the failure mode if any of the three writes errored.

import { describe, it, expect, vi } from "vitest";
import { persistOnboardingUpdates, type OnboardingPrisma } from "../../src/onboarding/prisma-deps.js";
import type { OnboardingUpdates, StepId } from "../../src/onboarding/types.js";

interface UserUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}
interface UpsertArgs {
  where: { userId: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

interface Spies {
  userUpdate: ReturnType<typeof vi.fn>;
  statsUpsert: ReturnType<typeof vi.fn>;
  preferencesUpsert: ReturnType<typeof vi.fn>;
  callOrder: string[];
}

function makeDb(): { db: OnboardingPrisma; spies: Spies } {
  const callOrder: string[] = [];
  const userUpdate = vi.fn(async (args: UserUpdateArgs) => {
    callOrder.push("user.update");
    return { id: args.where.id };
  });
  const statsUpsert = vi.fn(async (args: UpsertArgs) => {
    callOrder.push("stats.upsert");
    return { userId: args.where.userId };
  });
  const preferencesUpsert = vi.fn(async (args: UpsertArgs) => {
    callOrder.push("preferences.upsert");
    return { userId: args.where.userId };
  });
  const db: OnboardingPrisma = {
    user: { update: userUpdate } as never,
    stats: { upsert: statsUpsert } as never,
    preferences: { upsert: preferencesUpsert } as never,
  };
  return { db, spies: { userUpdate, statsUpsert, preferencesUpsert, callOrder } };
}

describe("persistOnboardingUpdates — base cursor advance", () => {
  it("writes only the cursor when there are no field updates", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(db, "u_1", {}, "ask_age", false);

    expect(spies.userUpdate).toHaveBeenCalledTimes(1);
    expect(spies.userUpdate.mock.calls[0]![0]).toEqual({
      where: { id: "u_1" },
      data: { onboardingStep: "ask_age" },
    });
    expect(spies.statsUpsert).not.toHaveBeenCalled();
    expect(spies.preferencesUpsert).not.toHaveBeenCalled();
  });

  it("uses the supplied nextStep verbatim (no normalization)", async () => {
    const { db, spies } = makeDb();
    const step: StepId = "ask_type_descriptor";
    await persistOnboardingUpdates(db, "u_1", {}, step, false);
    expect(spies.userUpdate.mock.calls[0]![0].data).toEqual({
      onboardingStep: step,
    });
  });
});

describe("persistOnboardingUpdates — markActive terminal write", () => {
  it("flips status to ACTIVE and clears the cursor, ignoring nextStep", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(db, "u_2", {}, "done", true);

    expect(spies.userUpdate).toHaveBeenCalledTimes(1);
    const data = spies.userUpdate.mock.calls[0]![0].data;
    expect(data).toEqual({
      onboardingStep: null,
      status: "ACTIVE",
    });
    // Belt-and-braces: the null must be present, not just absent
    // (Prisma `update` distinguishes "omit" from "set null").
    expect(Object.prototype.hasOwnProperty.call(data, "onboardingStep")).toBe(true);
    expect(data.onboardingStep).toBeNull();
  });

  it("clears the cursor even when nextStep is a real step (markActive wins)", async () => {
    // Today the flow only calls with (done, true), but the adapter's
    // contract is "markActive wins regardless of nextStep". Pin it so a
    // future short-circuit elsewhere can't desync.
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(db, "u_2b", {}, "ask_age", true);
    expect(spies.userUpdate.mock.calls[0]![0].data.onboardingStep).toBeNull();
    expect(spies.userUpdate.mock.calls[0]![0].data.status).toBe("ACTIVE");
  });

  it("merges field updates into the terminal write", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_3",
      { user: { campusEmailDomain: "stanford.edu" } },
      "done",
      true,
    );
    expect(spies.userUpdate.mock.calls[0]![0].data).toEqual({
      onboardingStep: null,
      status: "ACTIVE",
      campusEmailDomain: "stanford.edu",
    });
  });
});

describe("persistOnboardingUpdates — user field projection", () => {
  it("forwards displayName when present", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_4",
      { user: { displayName: "Alex" } },
      "ask_age",
      false,
    );
    expect(spies.userUpdate.mock.calls[0]![0].data).toEqual({
      onboardingStep: "ask_age",
      displayName: "Alex",
    });
  });

  it("forwards both user fields when present together", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_5",
      { user: { displayName: "Alex", campusEmailDomain: "stanford.edu" } },
      "ask_age",
      false,
    );
    expect(spies.userUpdate.mock.calls[0]![0].data).toEqual({
      onboardingStep: "ask_age",
      displayName: "Alex",
      campusEmailDomain: "stanford.edu",
    });
  });

  it("treats absent user fields as 'omit' (not 'set undefined')", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_6",
      { user: {} },
      "ask_age",
      false,
    );
    const data = spies.userUpdate.mock.calls[0]![0].data;
    expect(data).toEqual({ onboardingStep: "ask_age" });
    expect(Object.prototype.hasOwnProperty.call(data, "displayName")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data, "campusEmailDomain")).toBe(false);
  });

  it("missing `updates.user` is equivalent to an empty object", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(db, "u_7", {}, "ask_age", false);
    const data = spies.userUpdate.mock.calls[0]![0].data;
    expect(Object.prototype.hasOwnProperty.call(data, "displayName")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data, "campusEmailDomain")).toBe(false);
  });

  it("forwards an empty string for displayName (runtime !== undefined guard)", async () => {
    // The runtime guard is `!== undefined`, not truthiness. The current
    // type bans empty strings via parser validation, but the adapter
    // itself doesn't, and that contract matters: a parser change that
    // returns `""` should hit the DB, not be silently dropped here.
    const { db, spies } = makeDb();
    const updates = { user: { displayName: "" } } as unknown as OnboardingUpdates;
    await persistOnboardingUpdates(db, "u_8", updates, "ask_age", false);
    expect(spies.userUpdate.mock.calls[0]![0].data).toEqual({
      onboardingStep: "ask_age",
      displayName: "",
    });
  });
});

describe("persistOnboardingUpdates — stats upsert", () => {
  it("calls stats.upsert with canonical create+update payloads", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_9",
      { stats: { age: 22, profession: "physics" } },
      "ask_height_cm",
      false,
    );
    expect(spies.statsUpsert).toHaveBeenCalledTimes(1);
    expect(spies.statsUpsert.mock.calls[0]![0]).toEqual({
      where: { userId: "u_9" },
      create: { userId: "u_9", age: 22, profession: "physics" },
      update: { age: 22, profession: "physics" },
    });
  });

  it("does NOT inject `userId` into the update payload", async () => {
    // Update can't change the unique key; including it would either be
    // a no-op or risk a Prisma rejection on engines that validate it.
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_10",
      { stats: { age: 25 } },
      "ask_height_cm",
      false,
    );
    const args = spies.statsUpsert.mock.calls[0]![0];
    expect(Object.prototype.hasOwnProperty.call(args.update, "userId")).toBe(false);
    expect(args.create.userId).toBe("u_10");
  });

  it("skips the upsert when stats is missing", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(db, "u_11", {}, "ask_age", false);
    expect(spies.statsUpsert).not.toHaveBeenCalled();
  });

  it("skips the upsert when stats is present but empty", async () => {
    // This is the only guard against a `{}` upsert, which would fail at
    // runtime because the schema's create payload requires non-null
    // fields beyond userId.
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(db, "u_12", { stats: {} }, "ask_age", false);
    expect(spies.statsUpsert).not.toHaveBeenCalled();
  });

  it("forwards photoUrl alongside the other stat fields", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_13",
      { stats: { photoUrl: "https://cdn.example.test/a.jpg" } },
      "ask_preferred_genders",
      false,
    );
    expect(spies.statsUpsert.mock.calls[0]![0].create).toEqual({
      userId: "u_13",
      photoUrl: "https://cdn.example.test/a.jpg",
    });
  });
});

describe("persistOnboardingUpdates — preferences upsert", () => {
  it("calls preferences.upsert with canonical create+update payloads", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_14",
      { preferences: { minAge: 21, maxAge: 30 } },
      "ask_type_descriptor",
      false,
    );
    expect(spies.preferencesUpsert).toHaveBeenCalledTimes(1);
    expect(spies.preferencesUpsert.mock.calls[0]![0]).toEqual({
      where: { userId: "u_14" },
      create: { userId: "u_14", minAge: 21, maxAge: 30 },
      update: { minAge: 21, maxAge: 30 },
    });
  });

  it("does NOT inject `userId` into the update payload", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_15",
      { preferences: { typeDescriptor: "thoughtful" } },
      "ask_campus_email_domain",
      false,
    );
    const args = spies.preferencesUpsert.mock.calls[0]![0];
    expect(Object.prototype.hasOwnProperty.call(args.update, "userId")).toBe(false);
    expect(args.create.userId).toBe("u_15");
  });

  it("skips the upsert when preferences is missing", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(db, "u_16", {}, "ask_age", false);
    expect(spies.preferencesUpsert).not.toHaveBeenCalled();
  });

  it("skips the upsert when preferences is present but empty", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_17",
      { preferences: {} },
      "ask_age",
      false,
    );
    expect(spies.preferencesUpsert).not.toHaveBeenCalled();
  });

  it("forwards array-valued preferredGenders", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_18",
      { preferences: { preferredGenders: ["WOMAN", "NONBINARY"] as never } },
      "ask_min_age",
      false,
    );
    expect(spies.preferencesUpsert.mock.calls[0]![0].create).toEqual({
      userId: "u_18",
      preferredGenders: ["WOMAN", "NONBINARY"],
    });
  });
});

describe("persistOnboardingUpdates — composition & call order", () => {
  it("writes user, then stats, then preferences when all three are present", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_19",
      {
        user: { displayName: "Alex" },
        stats: { age: 22 },
        preferences: { minAge: 20 },
      },
      "ask_max_age",
      false,
    );
    expect(spies.callOrder).toEqual([
      "user.update",
      "stats.upsert",
      "preferences.upsert",
    ]);
  });

  it("still writes user when only the cursor moves", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(db, "u_20", {}, "ask_age", false);
    expect(spies.callOrder).toEqual(["user.update"]);
  });

  it("skips stats but writes preferences when only preferences populated", async () => {
    const { db, spies } = makeDb();
    await persistOnboardingUpdates(
      db,
      "u_21",
      { preferences: { typeDescriptor: "kind" } },
      "ask_campus_email_domain",
      false,
    );
    expect(spies.callOrder).toEqual(["user.update", "preferences.upsert"]);
  });

  it("propagates a user.update failure without touching stats / preferences", async () => {
    const { db, spies } = makeDb();
    spies.userUpdate.mockRejectedValueOnce(new Error("db down"));
    await expect(
      persistOnboardingUpdates(
        db,
        "u_22",
        { stats: { age: 22 }, preferences: { minAge: 21 } },
        "ask_max_age",
        false,
      ),
    ).rejects.toThrow(/db down/);
    expect(spies.statsUpsert).not.toHaveBeenCalled();
    expect(spies.preferencesUpsert).not.toHaveBeenCalled();
  });

  it("propagates a stats.upsert failure without touching preferences", async () => {
    const { db, spies } = makeDb();
    spies.statsUpsert.mockRejectedValueOnce(new Error("stats blew up"));
    await expect(
      persistOnboardingUpdates(
        db,
        "u_23",
        { stats: { age: 22 }, preferences: { minAge: 21 } },
        "ask_max_age",
        false,
      ),
    ).rejects.toThrow(/stats blew up/);
    expect(spies.userUpdate).toHaveBeenCalledTimes(1);
    expect(spies.preferencesUpsert).not.toHaveBeenCalled();
  });

  it("is idempotent at the spy level — same input yields same call shape", async () => {
    const { db, spies } = makeDb();
    const updates: OnboardingUpdates = {
      user: { displayName: "Alex" },
      stats: { age: 22 },
      preferences: { minAge: 20 },
    };
    await persistOnboardingUpdates(db, "u_24", updates, "ask_max_age", false);
    const firstUserArgs = spies.userUpdate.mock.calls[0]![0];
    const firstStatsArgs = spies.statsUpsert.mock.calls[0]![0];
    const firstPrefsArgs = spies.preferencesUpsert.mock.calls[0]![0];

    await persistOnboardingUpdates(db, "u_24", updates, "ask_max_age", false);
    expect(spies.userUpdate.mock.calls[1]![0]).toEqual(firstUserArgs);
    expect(spies.statsUpsert.mock.calls[1]![0]).toEqual(firstStatsArgs);
    expect(spies.preferencesUpsert.mock.calls[1]![0]).toEqual(firstPrefsArgs);
  });
});
