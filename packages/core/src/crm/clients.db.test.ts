import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeUser, meta, type TestDb } from "@demoq/testkit";
import { DomainError, execute, type OpDef, type UserActor } from "../kernel";
import { clientCreate, clientGet, clientList, clientUpdate, contactCreate, contactUpdate } from "./clients";
import { dealCreate } from "./deals";

let t: TestDb;
let lead: UserActor;
let otherLead: UserActor;
let ops: UserActor;
let staff: UserActor;

beforeAll(async () => {
  t = await createTestDb();
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  otherLead = await makeUser(t.db, { roles: ["account_lead"], name: "Dara Lead" });
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops" });
  staff = await makeUser(t.db, { roles: ["staff"], name: "Bopha Staff" });
});
afterAll(() => t.destroy());

const run = <T>(actor: UserActor, op: OpDef, input: unknown) =>
  execute(t.kernel, meta(actor), op, input) as Promise<T>;
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);

describe("crm/clients", () => {
  it("[CRM-CL-01] a client needs a name and an active account lead; the creator leads by default", async () => {
    await expectCode(run(lead, clientCreate, { name: "   " }), "VALIDATION");
    const c = await run<{ id: string }>(lead, clientCreate, { name: "Mekong Telecom", nameKm: "មេគង្គ តេឡេខម" });
    const row = await t.db.selectFrom("clients").selectAll().where("id", "=", c.id).executeTakeFirstOrThrow();
    expect(row.account_lead_id).toBe(lead.id);
    await t.migrator.updateTable("users").set({ active: false }).where("id", "=", otherLead.id).execute();
    await expectCode(run(ops, clientCreate, { name: "X", accountLeadId: otherLead.id }), "VALIDATION");
    await t.migrator.updateTable("users").set({ active: true }).where("id", "=", otherLead.id).execute();
  });

  it("[CRM-CL-02] account leads manage only their own clients; reassigning needs ops", async () => {
    const c = await run<{ id: string; version: number }>(lead, clientCreate, { name: "Phnom Penh Motors" });
    await expectCode(run(otherLead, clientUpdate, { id: c.id, expectedVersion: 1, name: "Hijack" }), "FORBIDDEN");
    await expectCode(run(lead, clientCreate, { name: "Not mine", accountLeadId: otherLead.id }), "FORBIDDEN");
    await expectCode(run(lead, clientUpdate, { id: c.id, expectedVersion: 1, accountLeadId: otherLead.id }), "FORBIDDEN");
    const r = await run<{ version: number }>(ops, clientUpdate, { id: c.id, expectedVersion: 1, accountLeadId: otherLead.id });
    expect(r.version).toBe(2);
    await expectCode(run(staff, clientCreate, { name: "Staff client" }), "FORBIDDEN");
  });

  it("[CRM-CL-03] staff can view clients", async () => {
    const c = await run<{ id: string }>(lead, clientCreate, { name: "Kampot Pepper Co" });
    const got = await run<{ name: string; deals: unknown; canManage: boolean }>(staff, clientGet, { id: c.id });
    expect(got.name).toBe("Kampot Pepper Co");
    expect(got.deals).toBeNull(); // staff hold no deal.view
    expect(got.canManage).toBe(false);
  });

  it("[CRM-CL-04] search matches English, Khmer, any case, and tolerates typos", async () => {
    await run(lead, clientCreate, { name: "Sabay Coffee", nameKm: "កាហ្វេសប្បាយ" });
    const names = async (search: string) => (await run<{ name: string }[]>(staff, clientList, { search })).map((c) => c.name);
    expect(await names("sabay")).toContain("Sabay Coffee");
    expect(await names("កាហ្វេ")).toContain("Sabay Coffee");
    expect(await names("Sabay Cofee")).toContain("Sabay Coffee");
    // NFC: a decomposed/composed string compares equal after normalisation.
    expect(await names("sabay coffee".normalize("NFD"))).toContain("Sabay Coffee");
  });

  it("[CRM-CL-05] one primary contact per client", async () => {
    const c = await run<{ id: string }>(lead, clientCreate, { name: "Royal Rice" });
    const a = await run<{ id: string }>(lead, contactCreate, { clientId: c.id, fullName: "Chan Thy", isPrimary: true });
    await run(lead, contactCreate, { clientId: c.id, fullName: "Lim Srey", isPrimary: true });
    const rows = await t.db.selectFrom("contacts").select(["full_name", "is_primary"]).where("client_id", "=", c.id).orderBy("full_name").execute();
    expect(rows).toEqual([
      { full_name: "Chan Thy", is_primary: false },
      { full_name: "Lim Srey", is_primary: true },
    ]);
    await run(lead, contactUpdate, { id: a.id, expectedVersion: 1, isPrimary: true });
    const primary = await t.db.selectFrom("contacts").select("full_name").where("client_id", "=", c.id).where("is_primary", "=", true).execute();
    expect(primary).toEqual([{ full_name: "Chan Thy" }]);
  });

  it("[CRM-CL-06] clients are archived, never deleted; archived clients get no new deals", async () => {
    const c = await run<{ id: string }>(lead, clientCreate, { name: "Old Client" });
    await expect(sql`DELETE FROM clients WHERE id = ${c.id}`.execute(t.db)).rejects.toThrow(/permission denied/);
    await run(lead, clientUpdate, { id: c.id, expectedVersion: 1, archived: true });
    const visible = (await run<{ id: string }[]>(staff, clientList, {})).map((x) => x.id);
    expect(visible).not.toContain(c.id);
    const all = (await run<{ id: string }[]>(staff, clientList, { includeArchived: true })).map((x) => x.id);
    expect(all).toContain(c.id);
    await expectCode(run(lead, dealCreate, { clientId: c.id, title: "New work" }), "VALIDATION");
  });

  it("[CRM-CL-07] edits need the current version", async () => {
    const c = await run<{ id: string }>(lead, clientCreate, { name: "Versioned" });
    await run(lead, clientUpdate, { id: c.id, expectedVersion: 1, industry: "FMCG" });
    await expectCode(run(lead, clientUpdate, { id: c.id, expectedVersion: 1, industry: "Retail" }), "STALE_VERSION");
  });

  it("[CRM-CL-08] new clients require a PO by default", async () => {
    const c = await run<{ id: string }>(lead, clientCreate, { name: "PO Default" });
    const got = await run<{ po_required: boolean }>(lead, clientGet, { id: c.id });
    expect(got.po_required).toBe(true);
  });
});
