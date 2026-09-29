// Task templates per project type. Spec: specs/tasks/tasks.md (TSK-TP-*)
import { z } from "zod";
import { optionalText, requiredText, uuid } from "@demoq/shared";
import { addDays, defineCommand, defineQuery, DomainError, notFoundIfMissing, type Ctx } from "../kernel";

const ItemInput = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(40),
  titleEn: requiredText(200),
  titleKm: optionalText(200),
  roleHint: z
    .string()
    .regex(/^[a-z][a-z_]*$/)
    .max(40)
    .nullish(),
  offsetDays: z.number().int().min(0).max(365),
  estimateMinutes: z.number().int().min(1).max(100_000),
  dependsOnKeys: z.array(z.string()).max(20).default([]),
  serviceCode: z.string().max(40).nullish(),
  clientFacing: z.boolean().default(false),
});

async function loadTemplate(ctx: Ctx, projectTypeId: string) {
  const t = await ctx.tx.selectFrom("task_templates").selectAll().where("project_type_id", "=", projectTypeId).executeTakeFirst();
  if (!t) return null;
  const items = await ctx.tx
    .selectFrom("task_template_items")
    .selectAll()
    .where("template_id", "=", t.id)
    .orderBy("position")
    .execute();
  return { ...t, items };
}

export const templateList = defineQuery({
  name: "task_template.list",
  summary: "Task templates, one per project type, with their items (admin)",
  // Admin edits templates and must be able to read them; admin holds no project.view.
  permission: "admin.config",
  input: z.object({}).default({}),
  exposeTo: ["web", "mcp"],
  async run(ctx) {
    const types = await ctx.tx
      .selectFrom("project_types")
      .select(["id", "code", "label_en", "label_km", "active"])
      .orderBy("label_en")
      .execute();
    const out = [];
    for (const pt of types) out.push({ projectType: pt, template: await loadTemplate(ctx, pt.id) });
    return out;
  },
});

/** TSK-TP-01: admin edits a project type's template; items depend only on earlier items. */
export const templateSave = defineCommand({
  name: "task_template.save",
  summary: "Save a project type's task template (admin)",
  permission: "admin.config",
  input: z.object({ projectTypeId: uuid, name: requiredText(200), items: z.array(ItemInput).max(100) }),
  exposeTo: ["web"],
  async run(ctx, i) {
    notFoundIfMissing(await ctx.tx.selectFrom("project_types").select("id").where("id", "=", i.projectTypeId).executeTakeFirst());
    const seen = new Set<string>();
    i.items.forEach((it, n) => {
      const bad = (message: string) => new DomainError("VALIDATION", { issues: [{ path: `items.${n}`, message }] });
      if (seen.has(it.key)) throw bad("Duplicate key");
      for (const d of it.dependsOnKeys) if (!seen.has(d)) throw bad(`Depends on "${d}", which is not an earlier item`);
      seen.add(it.key);
    });
    const t = await ctx.tx
      .insertInto("task_templates")
      .values({ project_type_id: i.projectTypeId, name: i.name })
      .onConflict((oc) =>
        oc.column("project_type_id").doUpdateSet((eb) => ({ name: i.name, version: eb("task_templates.version", "+", 1) })),
      )
      .returning(["id", "version"])
      .executeTakeFirstOrThrow();
    const existing = await ctx.tx
      .selectFrom("task_template_items")
      .select(["id", "key"])
      .where("template_id", "=", t.id)
      .execute();
    const removed = existing.filter((e) => !seen.has(e.key));
    if (removed.length) {
      // Items already used by tasks stay (tasks keep their history); unused ones are deleted.
      const used = new Set(
        (
          await ctx.tx
            .selectFrom("tasks")
            .select("template_item_id")
            .where(
              "template_item_id",
              "in",
              removed.map((r) => r.id),
            )
            .execute()
        ).map((r) => r.template_item_id),
      );
      const inUse = removed.filter((r) => used.has(r.id));
      if (inUse.length) throw new DomainError("VALIDATION", { reason: "template_item_in_use", keys: inUse.map((r) => r.key) });
      await ctx.tx
        .deleteFrom("task_template_items")
        .where(
          "id",
          "in",
          removed.map((r) => r.id),
        )
        .execute();
    }
    // Positions are unique: park the kept rows out of the way before renumbering.
    await ctx.tx
      .updateTable("task_template_items")
      .set((eb) => ({ position: eb("position", "+", 100_000) }))
      .where("template_id", "=", t.id)
      .execute();
    for (const [position, it] of i.items.entries()) {
      const v = {
        position,
        title_en: it.titleEn,
        title_km: it.titleKm ?? null,
        role_hint: it.roleHint ?? null,
        offset_days: it.offsetDays,
        estimate_minutes: it.estimateMinutes,
        depends_on_keys: it.dependsOnKeys,
        service_code: it.serviceCode ?? null,
        client_facing: it.clientFacing,
      };
      await ctx.tx
        .insertInto("task_template_items")
        .values({ template_id: t.id, key: it.key, ...v })
        .onConflict((oc) => oc.columns(["template_id", "key"]).doUpdateSet(v))
        .execute();
    }
    return { id: t.id, version: t.version, items: i.items.length };
  },
  subject: (i) => ({ type: "project_type", id: i.projectTypeId }),
});

/**
 * TSK-TP-02: a new project gets its type's template tasks. Owner = the member whose project role matches the hint,
 * else the PM; due = planned start + offset; dependencies copied; linked to the first scope item with the same
 * service code, else non-deliverable — and then never client-facing (INV-20: an unscoped client deliverable would
 * otherwise skip the out-of-scope approval). The PM links it to a scope item and marks it client-facing later.
 */
export async function applyTemplate(
  ctx: Ctx,
  p: { id: string; project_type_id: string; planned_start: string; pm_id: string; scope_id: string | null },
): Promise<number> {
  const t = await loadTemplate(ctx, p.project_type_id);
  if (!t?.items.length) return 0;
  const members = await ctx.tx
    .selectFrom("project_members")
    .select(["user_id", "project_role"])
    .where("project_id", "=", p.id)
    .orderBy("created_at")
    .execute();
  const scopeItems = p.scope_id
    ? await ctx.tx
        .selectFrom("scope_items")
        .select(["id", "service_code", "kind"])
        .where("scope_id", "=", p.scope_id)
        .orderBy("created_at")
        .execute()
    : [];
  const ids = new Map<string, string>();
  for (const it of t.items) {
    const owner = members.find((m) => it.role_hint && m.project_role === it.role_hint)?.user_id ?? p.pm_id;
    const link = it.service_code ? scopeItems.find((s) => s.kind === "fee" && s.service_code === it.service_code) : undefined;
    const row = await ctx.tx
      .insertInto("tasks")
      .values({
        project_id: p.id,
        title: it.title_en,
        owner_id: owner,
        estimate_minutes: it.estimate_minutes,
        estimate_source: "template",
        due_date: addDays(p.planned_start, it.offset_days),
        scope_item_id: link?.id ?? null,
        non_deliverable: !link,
        client_facing: it.client_facing && !!link,
        template_item_id: it.id,
        rank: it.position,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    ids.set(it.key, row.id);
    const deps = it.depends_on_keys.map((k) => ids.get(k)).filter((x): x is string => !!x);
    if (deps.length)
      await ctx.tx
        .insertInto("task_dependencies")
        .values(deps.map((d) => ({ task_id: row.id, depends_on_id: d })))
        .execute();
  }
  return t.items.length;
}
