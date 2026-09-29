// Time reference data: activity codes (D-TM-1) and public holidays (D15, D-HD-1). Everyone reads; admin edits.
// Spec: specs/time/timesheets.md (TIM-TS-01), specs/time/leave-holidays.md (TIM-LV-01, TIM-LV-02, TIM-LV-07)
import { z } from "zod";
import { isoDate, requiredText } from "@demoq/shared";
import { addDays, assertVersion, businessDate, defineCommand, defineQuery, DomainError, notFoundIfMissing } from "../kernel";
import { ownScope, selfId } from "./attendance";
import { loadCalendarUser, workingCalendar } from "./calendar";

const code = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "lower_snake_case");

export const activityCodeList = defineQuery({
  name: "activity_code.list",
  summary: "Internal activity codes for non-client time (admin, training, pitch, …)",
  permission: "user.directory",
  input: z.object({ includeInactive: z.boolean().default(false) }),
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const rows = await ctx.tx
      .selectFrom("activity_codes")
      .selectAll()
      .$if(!i.includeInactive, (q) => q.where("active", "=", true))
      .orderBy("position")
      .orderBy("code")
      .execute();
    return rows.map((r) => ({
      code: r.code,
      labelEn: r.label_en,
      labelKm: r.label_km,
      active: r.active,
      position: r.position,
      version: r.version,
    }));
  },
});

export const activityCodeUpsert = defineCommand({
  name: "activity_code.upsert",
  summary: "Create or edit an internal activity code",
  permission: "admin.config",
  input: z.object({
    code,
    labelEn: requiredText(100),
    labelKm: requiredText(100),
    active: z.boolean().default(true),
    position: z.number().int().min(0).max(10_000).default(100),
    expectedVersion: z.number().int().positive().optional(),
  }),
  exposeTo: ["web"],
  async run(ctx, i) {
    const cur = await ctx.tx
      .selectFrom("activity_codes")
      .select("version")
      .where("code", "=", i.code)
      .forUpdate()
      .executeTakeFirst();
    const values = { label_en: i.labelEn, label_km: i.labelKm, active: i.active, position: i.position };
    if (!cur) {
      return ctx.tx
        .insertInto("activity_codes")
        .values({ code: i.code, ...values })
        .returning(["code", "version"])
        .executeTakeFirstOrThrow();
    }
    if (i.expectedVersion === undefined)
      throw new DomainError("VALIDATION", { issues: [{ path: "expectedVersion", message: "Required for updates" }] });
    assertVersion(cur.version, i.expectedVersion);
    return ctx.tx
      .updateTable("activity_codes")
      .set({ ...values, version: cur.version + 1 })
      .where("code", "=", i.code)
      .returning(["code", "version"])
      .executeTakeFirstOrThrow();
  },
});

const holidayDto = (h: {
  holiday_date: string;
  name_en: string;
  name_km: string;
  source: string;
  verified: boolean;
  verified_at: Date | null;
  version: number;
}) => ({
  date: h.holiday_date,
  nameEn: h.name_en,
  nameKm: h.name_km,
  source: h.source,
  verified: h.verified,
  verifiedAt: h.verified_at,
  version: h.version,
});

/** TIM-LV-01: everyone lists public holidays (unverified ones are marked). */
export const holidayList = defineQuery({
  name: "holiday.list",
  summary: "Public holidays for a year (Cambodian sub-decree; unverified entries are marked)",
  permission: "user.directory",
  input: z.object({ year: z.number().int().min(2020).max(2100).optional() }),
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const year = i.year ?? Number(businessDate(ctx.now).slice(0, 4));
    const rows = await ctx.tx
      .selectFrom("holidays")
      .selectAll()
      .where("holiday_date", ">=", `${year}-01-01`)
      .where("holiday_date", "<=", `${year}-12-31`)
      .orderBy("holiday_date")
      .execute();
    return rows.map(holidayDto);
  },
});

/** TIM-LV-02: admin adds, edits or confirms (verifies) a holiday. */
export const holidayUpsert = defineCommand({
  name: "holiday.upsert",
  summary: "Add or edit a public holiday, or mark it verified against the official sub-decree",
  permission: "admin.config",
  input: z.object({
    date: isoDate,
    nameEn: requiredText(200),
    nameKm: requiredText(200),
    source: requiredText(300),
    verified: z.boolean().default(false),
    expectedVersion: z.number().int().positive().optional(),
  }),
  exposeTo: ["web"],
  async run(ctx, i) {
    const me = selfId(ctx);
    const cur = await ctx.tx
      .selectFrom("holidays")
      .select(["id", "version", "verified"])
      .where("holiday_date", "=", i.date)
      .forUpdate()
      .executeTakeFirst();
    const verified = {
      verified: i.verified,
      verified_by: i.verified ? me : null,
      verified_at: i.verified ? ctx.now : null,
    };
    const values = { name_en: i.nameEn, name_km: i.nameKm, source: i.source, ...verified };
    const row = !cur
      ? await ctx.tx
          .insertInto("holidays")
          .values({ holiday_date: i.date, ...values })
          .returningAll()
          .executeTakeFirstOrThrow()
      : await (async () => {
          if (i.expectedVersion === undefined)
            throw new DomainError("VALIDATION", { issues: [{ path: "expectedVersion", message: "Required for updates" }] });
          assertVersion(cur.version, i.expectedVersion);
          return ctx.tx
            .updateTable("holidays")
            .set({ ...values, version: cur.version + 1 })
            .where("id", "=", cur.id)
            .returningAll()
            .executeTakeFirstOrThrow();
        })();
    return holidayDto(row);
  },
  subject: () => undefined,
});

export const holidayRemove = defineCommand({
  name: "holiday.remove",
  summary: "Remove a public holiday that is not on the official list",
  permission: "admin.config",
  input: z.object({ date: isoDate, expectedVersion: z.number().int().positive() }),
  exposeTo: ["web"],
  async run(ctx, i) {
    const cur = notFoundIfMissing(
      await ctx.tx
        .selectFrom("holidays")
        .select(["id", "version"])
        .where("holiday_date", "=", i.date)
        .forUpdate()
        .executeTakeFirst(),
    );
    assertVersion(cur.version, i.expectedVersion);
    await ctx.tx.deleteFrom("holidays").where("id", "=", cur.id).execute();
    return { date: i.date, removed: true };
  },
});

/** TIM-LV-07: my working days between two dates (working days − holidays − approved leave), for planning. */
export const timeCalendar = defineQuery({
  name: "time.calendar",
  summary: "My working calendar: working days, holidays and approved leave between two dates",
  permission: "time.allocate_own",
  input: z.object({ from: isoDate, to: isoDate }),
  exposeTo: ["web", "mcp"],
  scope: ownScope,
  async run(ctx, i) {
    if (i.to < i.from || i.to > addDays(i.from, 92))
      throw new DomainError("VALIDATION", { issues: [{ path: "to", message: "Within 92 days after from" }] });
    const u = notFoundIfMissing(await loadCalendarUser(ctx.tx, selfId(ctx)));
    const days = await workingCalendar(ctx.tx, u, i.from, i.to);
    return { from: i.from, to: i.to, workingDays: days.filter((d) => d.workingDay).length, days };
  },
});
