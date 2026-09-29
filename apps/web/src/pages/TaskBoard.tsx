// Task Kanban (specs/tasks/tasks.md, specs/tasks/delivery.md): per project (TaskBoard) and per person (MyTasks).
// Columns for every state the board returns (TSK-DL-01, TSK-DL-12). The buttons on a card are exactly the task's
// `actions` from the server: start / back / finish, submit for QC, mark sent (asks for what was sent), client revision
// (round 4 asks for rework minutes and a note and waits for an out-of-scope decision; round 5 is a hard stop) and
// client accepted. Each card says what blocks it: missing gates (PRJ-GT-04), open dependencies (TSK-TK-04), a pending
// out-of-scope decision (TSK-TK-02), a closed project, a QC that is not approved yet (INV-10).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type DragEvent, type FormEvent } from "react";
import { ApiError, hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field, Modal } from "../components/ui";
import { addDaysIso, formatMinutes, parseHours, phnomPenhToday } from "../format";
import { useI18n } from "../i18n";
import { useDirectory, useProjects, useScope } from "../queries";
import { Link } from "../router";
import type { Gate, ProjectDetail, ProjectStatus, Task, TaskAction, TaskBoardData, TaskDetail, TaskStatus } from "../types";

type Column = Exclude<TaskStatus, "cancelled">;
const COLUMNS: Column[] = ["todo", "in_progress", "internal_review", "client_ready", "client_review", "done"];
/** TSK-TK-03: the plain moves (task.move); everything else is a delivery command. */
const MOVE_TO: Partial<Record<TaskAction, "todo" | "in_progress" | "done">> = {
  start: "in_progress",
  stop: "todo",
  finish: "done",
};
type DeliveryAction = "submit_qc" | "mark_sent" | "request_revision" | "client_accept";
/** Order of the buttons on a card (cancel is a separate link). */
const BUTTONS: TaskAction[] = ["start", "submit_qc", "mark_sent", "request_revision", "client_accept", "finish", "stop"];
const MAX_ROUND = 4; // D1: round 4 needs an out-of-scope decision, round 5 never exists

/** What the board knows about a task's project, to explain why a card cannot start. */
interface ProjectInfo {
  kind: "client" | "internal";
  status: ProjectStatus;
  uncovered: Gate[];
}

/** A refused action. GATE_BLOCKED lists the gates still missing (from the error, else from the project itself). */
interface ActionError {
  error: unknown;
  gates: Gate[] | null;
}

/** Input the delivery commands need from a person (mark sent, revision request). */
interface ActionInput {
  sentReference?: string;
  note?: string | null;
  reworkMinutes?: number;
}

async function runAction(task: Task, action: TaskAction, input: ActionInput = {}) {
  const base = { id: task.id, expectedVersion: task.version };
  const to = MOVE_TO[action];
  if (to) return op("task.move", { ...base, to });
  switch (action) {
    case "submit_qc":
      return op("task.submit_qc", base);
    case "mark_sent":
      return op("task.mark_sent", { ...base, sentReference: input.sentReference });
    case "request_revision":
      return op("task.request_revision", {
        ...base,
        ...(input.note ? { note: input.note } : {}),
        ...(input.reworkMinutes ? { reworkMinutes: input.reworkMinutes } : {}),
      });
    case "client_accept":
      return op("task.client_accept", base);
    default:
      return op("task.cancel", base);
  }
}

type Dialog = { task: Task; action: "mark_sent" | "request_revision" };

function useActions(onDone: () => Promise<unknown>) {
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** Runs the action (or opens its dialog); returns the error for dialogs, else null. */
  const act = async (task: Task, action: TaskAction, input?: ActionInput): Promise<unknown> => {
    if (!input && (action === "mark_sent" || action === "request_revision")) {
      setActionError(null);
      setDialog({ task, action });
      return null;
    }
    setBusy(task.id);
    setActionError(null);
    try {
      await runAction(task, action, input);
      await onDone();
      return null;
    } catch (e) {
      let gates: Gate[] | null = null;
      if (e instanceof ApiError && e.code === "GATE_BLOCKED") {
        const fromError = e.problem.params?.missing;
        gates = Array.isArray(fromError)
          ? (fromError as Gate[])
          : await op<ProjectDetail>("project.get", { id: task.project_id })
              .then((p) => p.gateStatus.uncovered)
              .catch(() => null);
      }
      if (!input) setActionError({ error: e, gates });
      if (e instanceof ApiError && e.code === "STALE_VERSION") await onDone();
      return e;
    } finally {
      setBusy(null);
    }
  };
  return { act, actionError, busy, dialog, closeDialog: () => setDialog(null) };
}

function ActionErrorBanner({ e }: { e: ActionError | null }) {
  const { t, err } = useI18n();
  if (!e) return null;
  if (e.error instanceof ApiError && e.error.code === "GATE_BLOCKED") {
    return (
      <div role="alert" className="error" data-testid="error" data-code="GATE_BLOCKED">
        {err("GATE_BLOCKED")}
        {e.gates && e.gates.length > 0 && (
          <span data-testid="gate-blocked-gates" data-gates={e.gates.join(",")}>
            {" "}
            {t("gatesMissing", { gates: e.gates.map((g) => t(`gate.${g}`)).join(", ") })}
          </span>
        )}
      </div>
    );
  }
  return <ErrorBanner error={e.error} />;
}

// ---- Per project -----------------------------------------------------------------------------

export function TaskBoard({ project, me, openTaskId }: { project: ProjectDetail; me: Me; openTaskId?: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const board = useQuery({
    queryKey: ["task-board", project.id],
    queryFn: () => op<TaskBoardData>("task.board", { projectId: project.id }),
  });
  const refresh = () =>
    Promise.all(
      [["task-board", project.id], ["project", project.id], ["my-tasks"], ["task"], ["approvals"]].map((k) =>
        qc.invalidateQueries({ queryKey: k }),
      ),
    );
  const actions = useActions(refresh);
  const [creating, setCreating] = useState(false);
  const [details, setDetails] = useState<string | null>(openTaskId ?? null);
  const info: ProjectInfo = { kind: project.kind, status: project.status, uncovered: project.gateStatus.uncovered };
  const open = ["gated", "active", "on_hold"].includes(project.status);
  return (
    <div className="task-board">
      <div className="toolbar compact">
        <h3>{t("tasks")}</h3>
        {board.data?.canManage && open && (
          <button className="primary" onClick={() => setCreating(true)} data-testid="task-new">
            {t("newTask")}
          </button>
        )}
      </div>
      <ActionErrorBanner e={actions.actionError} />
      <ErrorBanner error={board.error} />
      {board.isLoading && <p>{t("loading")}</p>}
      {board.data && (
        <Kanban
          tasks={board.data.tasks}
          projectInfo={() => info}
          canDeliver={(task) => board.data!.canManage || task.owner_id === me.id}
          onAction={actions.act}
          onOpen={setDetails}
          busy={actions.busy}
        />
      )}
      {creating && board.data && (
        <NewTaskModal project={project} board={board.data} me={me} onClose={() => setCreating(false)} onCreated={refresh} />
      )}
      {actions.dialog && <ActionDialog {...actions.dialog} onClose={actions.closeDialog} onSubmit={actions.act} />}
      {details && <TaskDetailsModal id={details} onClose={() => setDetails(null)} />}
    </div>
  );
}

// ---- Per person ------------------------------------------------------------------------------

export function MyTasks({ me }: { me: Me }) {
  const { t, label } = useI18n();
  const qc = useQueryClient();
  const users = useDirectory(me);
  const [ownerId, setOwnerId] = useState(me.id);
  const tasks = useQuery({
    queryKey: ["my-tasks", ownerId],
    queryFn: () => op<Task[]>("task.mine", { ownerId, includeDone: true }),
  });
  // Every open project's status and uncovered gates, to explain blocked cards across projects.
  const projects = useProjects(me, false);
  const refresh = () =>
    Promise.all(
      [["my-tasks"], ["task-board"], ["project"], ["task"], ["approvals"]].map((k) => qc.invalidateQueries({ queryKey: k })),
    );
  const actions = useActions(refresh);
  const [details, setDetails] = useState<string | null>(null);
  const infoFor = (task: Task): ProjectInfo | undefined => {
    const p = projects.data?.find((x) => x.id === task.project_id);
    return p ? { kind: p.kind, status: p.status, uncovered: p.missingGates } : undefined;
  };
  // Only people who manage tasks look at someone else's board.
  const manager = hasPerm(me, "task.manage");
  const pickPerson = manager && !!users.data;
  return (
    <section>
      <div className="toolbar">
        <h1>
          {ownerId === me.id ? t("myTasks") : t("tasksOf", { who: users.data?.find((u) => u.id === ownerId)?.displayName ?? "" })}
        </h1>
        {pickPerson && (
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            aria-label={t("person")}
            className="auto"
            data-testid="tasks-person"
          >
            {users.data!.map((u) => (
              <option key={u.id} value={u.id}>
                {label(u.displayName, u.displayNameKm)}
              </option>
            ))}
          </select>
        )}
      </div>
      <ActionErrorBanner e={actions.actionError} />
      <ErrorBanner error={tasks.error} />
      {tasks.isLoading && <p>{t("loading")}</p>}
      {tasks.data && (
        <Kanban
          tasks={tasks.data}
          projectInfo={infoFor}
          canDeliver={(task) => task.owner_id === me.id || manager}
          onAction={actions.act}
          onOpen={setDetails}
          busy={actions.busy}
          showProject
        />
      )}
      {actions.dialog && <ActionDialog {...actions.dialog} onClose={actions.closeDialog} onSubmit={actions.act} />}
      {details && <TaskDetailsModal id={details} onClose={() => setDetails(null)} />}
    </section>
  );
}

// ---- The board itself ------------------------------------------------------------------------

function Kanban({
  tasks,
  projectInfo,
  canDeliver,
  onAction,
  onOpen,
  busy,
  showProject = false,
}: {
  tasks: Task[];
  projectInfo: (t: Task) => ProjectInfo | undefined;
  canDeliver: (t: Task) => boolean;
  onAction: (t: Task, a: TaskAction) => void;
  onOpen: (id: string) => void;
  busy: string | null;
  showProject?: boolean;
}) {
  const { t } = useI18n();
  const [over, setOver] = useState<Column | null>(null);
  const onDrop = (e: DragEvent, to: Column) => {
    e.preventDefault();
    setOver(null);
    const task = tasks.find((x) => x.id === e.dataTransfer.getData("text/task-id"));
    const action = task?.actions.find((a) => MOVE_TO[a] === to);
    if (task && action) onAction(task, action);
  };
  return (
    <div className="board task-kanban" data-testid="task-board">
      {COLUMNS.map((col) => {
        const cards = tasks.filter((x) => x.status === col);
        return (
          <div
            key={col}
            className={`column${over === col ? " over" : ""}`}
            data-testid={`task-column-${col}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(col);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => onDrop(e, col)}
          >
            <h3>
              {t(`taskStatus.${col}`)} <span className="count">{cards.length}</span>
            </h3>
            {cards.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                all={tasks}
                info={projectInfo(task)}
                deliverer={canDeliver(task)}
                onAction={onAction}
                onOpen={onOpen}
                busy={busy === task.id}
                showProject={showProject}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  all,
  info,
  deliverer,
  onAction,
  onOpen,
  busy,
  showProject,
}: {
  task: Task;
  all: Task[];
  info: ProjectInfo | undefined;
  deliverer: boolean;
  onAction: (t: Task, a: TaskAction) => void;
  onOpen: (id: string) => void;
  busy: boolean;
  showProject: boolean;
}) {
  const { t, date } = useI18n();
  const col = task.status as Column;
  const today = phnomPenhToday();
  const actions = task.actions ?? [];
  // Why this card cannot start (only matters before it starts).
  const blocked: { key: string; text: string }[] = [];
  if (col === "todo") {
    if (info && (info.status === "on_hold" || info.status === "completed" || info.status === "cancelled")) {
      blocked.push({ key: "project", text: t("blockedProject", { status: t(`projectStatus.${info.status}`) }) });
    }
    if (info?.kind === "client" && info.uncovered.length) {
      blocked.push({ key: "gates", text: t("blockedGates", { gates: info.uncovered.map((g) => t(`gate.${g}`)).join(", ") }) });
    }
    if (task.blockedByDependencies) {
      const titles = task.dependsOn
        .map((id) => all.find((x) => x.id === id))
        .filter((x) => x && x.status !== "done")
        .map((x) => x!.title);
      blocked.push({
        key: "deps",
        text: titles.length ? t("blockedDeps", { tasks: titles.join(", ") }) : t("blockedDepsUnknown"),
      });
    }
    if (task.oos_status === "pending") blocked.push({ key: "oos", text: t("blockedOos") });
    if (task.oos_status === "rejected") blocked.push({ key: "oos", text: t("oosRejected") });
  }
  // INV-10: nothing reaches the client before a non-owner approves this round's QC.
  if (col === "internal_review") blocked.push({ key: "qc", text: t("waitingForQc") });
  const rr = task.revisionRequest;
  const showDelivery = task.client_facing || task.revision_round > 0 || !!task.qc;
  const hardStop = task.nextRevision === "hard_stop";
  const markSentLocked = deliverer && task.client_facing && col === "internal_review";
  const revisionLocked = deliverer && col === "client_review" && !actions.includes("request_revision");
  const buttons = BUTTONS.filter((a) => actions.includes(a));
  return (
    <article
      className={`deal-card task-card${blocked.length ? " blocked" : ""}`}
      draggable={actions.some((a) => MOVE_TO[a])}
      onDragStart={(e) => e.dataTransfer.setData("text/task-id", task.id)}
      data-testid={`task-${task.id}`}
      data-title={task.title}
      data-status={task.status}
      data-round={task.revision_round}
    >
      <button type="button" className="link title" onClick={() => onOpen(task.id)} data-testid="task-open">
        {task.title}
      </button>
      {showProject && (
        <Link to={`/projects/${task.project_id}/tasks`} className="small">
          {task.project_name}
        </Link>
      )}
      <div className="meta">
        <span>{task.owner_name}</span>
        <span>{formatMinutes(task.estimate_minutes)}</span>
      </div>
      <div className="meta">
        <span className={col !== "done" && task.due_date < today ? "overdue-text" : ""}>
          {t("dueOn", { date: task.due_date })}
        </span>
        <span>
          {task.non_deliverable && <span className="tag">{t("nonDeliverable")}</span>}
          {task.oos_status !== "none" && <span className="tag">{t("outOfScope")}</span>}
        </span>
      </div>
      {showDelivery && (
        <div className="chips delivery" data-testid="task-delivery">
          {task.client_facing && <span className="chip">{t("clientFacing")}</span>}
          <span
            className={`chip${task.revision_round >= MAX_ROUND ? " missing" : ""}`}
            data-testid="task-round"
            data-round={task.revision_round}
          >
            {t("roundN", { n: String(task.revision_round), max: String(MAX_ROUND) })}
          </span>
          {task.qc && (
            <span className={`chip qc-${task.qc.status}`} data-testid="task-qc" data-status={task.qc.status}>
              {t(`qcStatus.${task.qc.status}`)}
            </span>
          )}
        </div>
      )}
      {task.sent_reference && (col === "client_review" || col === "done") && (
        <p className="small muted sent-ref" data-testid="task-sent">
          {t("sentRef", { ref: task.sent_reference, when: task.sent_to_client_at ? date(task.sent_to_client_at) : "" })}
        </p>
      )}
      {rr && (
        <div
          className={`round-request${rr.status === "pending" ? " pending" : ""}`}
          data-testid="task-round4"
          data-status={rr.status}
          data-outcome={rr.outcome ?? ""}
        >
          {rr.status === "pending" ? (
            t("round4Pending", { hours: rr.reworkMinutes ? formatMinutes(rr.reworkMinutes) : "—" })
          ) : rr.status === "approved" || rr.status === "rejected" ? (
            <>
              {t(`round4Outcome.${rr.outcome ?? (rr.status === "approved" ? "absorb" : "reject")}`)}
              {rr.note && <span className="muted"> — “{rr.note}”</span>}
            </>
          ) : (
            t(`approvalStatus.${rr.status}`)
          )}
        </div>
      )}
      {blocked.length > 0 && (
        <ul className="blocked-list" data-testid="task-blocked">
          {blocked.map((b) => (
            <li key={b.key} data-reason={b.key}>
              {b.text}
            </li>
          ))}
        </ul>
      )}
      {hardStop && col === "client_review" && (
        <p className="small hard-stop" data-testid="task-hard-stop">
          {t("hardStopHint")}
        </p>
      )}
      {(buttons.length > 0 || markSentLocked || revisionLocked || task.qc?.canDecide || actions.includes("cancel")) && (
        <div className="task-actions">
          {buttons.map((a) => {
            const move = MOVE_TO[a];
            return (
              <button
                key={a}
                className={a === "stop" ? "" : "primary"}
                disabled={busy}
                onClick={() => onAction(task, a)}
                data-testid={move ? `task-move-${move}` : `task-action-${a}`}
              >
                {move ? t(`taskMove.${move}`) : t(`taskAction.${a as DeliveryAction}`)}
              </button>
            );
          })}
          {markSentLocked && (
            <button disabled title={t("waitingForQc")} data-testid="task-action-mark_sent">
              {t("taskAction.mark_sent")}
            </button>
          )}
          {revisionLocked && (
            <button
              disabled
              title={hardStop ? t("hardStopHint") : t("round4PendingShort")}
              data-testid="task-action-request_revision"
            >
              {t("taskAction.request_revision")}
            </button>
          )}
          {task.qc?.canDecide && (
            <Link to="/inbox" className="small" testId="task-qc-review">
              {t("reviewQc")}
            </Link>
          )}
          {actions.includes("cancel") && (
            <button className="link small" disabled={busy} onClick={() => onAction(task, "cancel")} data-testid="task-cancel">
              {t("cancelTask")}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

// ---- Mark sent / client revision (TSK-DL-06, TSK-DL-07) -------------------------------------

function ActionDialog({
  task,
  action,
  onClose,
  onSubmit,
}: Dialog & {
  onClose: () => void;
  onSubmit: (t: Task, a: TaskAction, input: ActionInput) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [hours, setHours] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const oos = action === "request_revision" && task.nextRevision === "out_of_scope";
  const minutes = parseHours(hours);
  const valid = action === "mark_sent" ? reference.trim().length > 0 : !oos || (!!minutes && note.trim().length > 0);
  const next = task.revision_round + 1;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    const input: ActionInput =
      action === "mark_sent"
        ? { sentReference: reference.trim() }
        : { note: note.trim() || null, ...(oos && minutes ? { reworkMinutes: minutes } : {}) };
    const err = await onSubmit(task, action, input);
    if (err) {
      setError(err);
      setBusy(false);
    } else onClose();
  };
  return (
    <Modal
      title={action === "mark_sent" ? t("markSentTitle") : t("revisionTitle", { n: String(next) })}
      onClose={onClose}
      testId={action === "mark_sent" ? "sent-modal" : "revision-modal"}
    >
      <form onSubmit={submit}>
        <p className="muted small">{task.title}</p>
        <ErrorBanner error={error} />
        {action === "mark_sent" ? (
          <Field label={t("sentReference")}>
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={500}
              placeholder={t("sentReferenceHint")}
              required
              autoFocus
              data-testid="sent-reference"
            />
          </Field>
        ) : (
          <>
            {oos && (
              <p className="notice" data-testid="revision-oos-help">
                {t("round4Help")}
              </p>
            )}
            {oos && (
              <Field label={t("reworkHours")}>
                <input
                  inputMode="decimal"
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                  aria-invalid={hours !== "" && minutes === null}
                  placeholder="3"
                  required
                  data-testid="revision-hours"
                />
              </Field>
            )}
            <Field label={oos ? t("revisionNoteRequired") : t("revisionNote")}>
              <textarea
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                required={oos}
                data-testid="revision-note"
              />
            </Field>
          </>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            className="primary"
            disabled={busy || !valid}
            data-testid={action === "mark_sent" ? "sent-submit" : "revision-submit"}
          >
            {action === "mark_sent"
              ? t("taskAction.mark_sent")
              : oos
                ? t("askOosDecision")
                : t("startRound", { n: String(next) })}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- The task view (TSK-DL-12: its rounds) --------------------------------------------------

function TaskDetailsModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, date } = useI18n();
  const task = useQuery({ queryKey: ["task", id], queryFn: () => op<TaskDetail>("task.get", { id }) });
  const k = task.data;
  return (
    <Modal title={k?.title ?? t("loading")} onClose={onClose} testId="task-details">
      <ErrorBanner error={task.error} />
      {k && (
        <>
          <dl className="facts">
            <dt>{t("project")}</dt>
            <dd>{k.project_name}</dd>
            <dt>{t("taskState")}</dt>
            <dd data-testid="task-details-status">{t(`taskStatus.${k.status}`)}</dd>
            <dt>{t("owner")}</dt>
            <dd>{k.owner_name}</dd>
            <dt>{t("revisionRound")}</dt>
            <dd data-testid="task-details-round">{t("roundN", { n: String(k.revision_round), max: String(MAX_ROUND) })}</dd>
            {k.sent_reference && (
              <>
                <dt>{t("sentReference")}</dt>
                <dd>
                  {k.sent_reference}
                  {k.sent_to_client_at ? ` · ${date(k.sent_to_client_at)}` : ""}
                </dd>
              </>
            )}
          </dl>
          <h3>{t("rounds")}</h3>
          {k.rounds.length === 0 ? (
            <p className="muted small">{t("noRounds")}</p>
          ) : (
            <ul className="timeline" data-testid="task-rounds">
              {k.rounds.map((r, i) => (
                <li key={i} data-kind={r.kind} data-round={r.round}>
                  <strong>
                    {r.kind === "internal"
                      ? t("roundInternal", { n: String(r.round) })
                      : t("roundClient", { n: String(r.round) })}
                  </strong>
                  {r.approval_status && <span className="tag">{t(`approvalStatus.${r.approval_status}`)}</span>}
                  <div className="muted small">
                    {r.requested_by_name} · {date(r.created_at)}
                    {r.rework_minutes ? ` · ${t("rework", { hours: formatMinutes(r.rework_minutes) })}` : ""}
                  </div>
                  {r.note && <div className="small">{r.note}</div>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="actions">
        <button type="button" onClick={onClose} data-testid="task-details-close">
          {t("close")}
        </button>
      </div>
    </Modal>
  );
}

// ---- Create a task (TSK-TK-01/02) ------------------------------------------------------------

type ScopeLink = "scope" | "non_deliverable" | "out_of_scope";

function NewTaskModal({
  project,
  board,
  me,
  onClose,
  onCreated,
}: {
  project: ProjectDetail;
  board: TaskBoardData;
  me: Me;
  onClose: () => void;
  onCreated: () => Promise<unknown>;
}) {
  const { t, label, money } = useI18n();
  const users = useDirectory(me);
  const scope = useScope(project.id, !!project.scope_id);
  const client = project.kind === "client";
  const [title, setTitle] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [hours, setHours] = useState("");
  const [dueDate, setDueDate] = useState(addDaysIso(phnomPenhToday(), 7));
  const [link, setLink] = useState<ScopeLink>(client ? "scope" : "non_deliverable");
  const [scopeItemId, setScopeItemId] = useState("");
  const [oosReason, setOosReason] = useState("");
  const [deps, setDeps] = useState<string[]>([]);
  // D-QC-1: client-facing work goes through QC, mark sent and client acceptance.
  const [clientFacing, setClientFacing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const minutes = parseHours(hours);
  const linkOk = !client || (link === "scope" ? !!scopeItemId : link === "out_of_scope" ? oosReason.trim().length > 0 : true);
  const valid = title.trim() && ownerId && minutes && dueDate && linkOk;
  // Members first (they are who the work is for), then everyone else.
  const memberIds = new Set(project.members.map((m) => m.user_id));
  const people = [...(users.data ?? [])].sort((a, b) => Number(memberIds.has(b.id)) - Number(memberIds.has(a.id)));
  const openTasks = board.tasks.filter((x) => x.status !== "cancelled");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await op("task.create", {
        projectId: project.id,
        title: title.trim(),
        ownerId,
        estimateMinutes: minutes,
        dueDate,
        ...(client && link === "scope" && { scopeItemId }),
        ...(link === "non_deliverable" && { nonDeliverable: true }),
        ...(client && link === "out_of_scope" && { outOfScopeReason: oosReason.trim() }),
        dependsOn: deps,
        clientFacing: client && clientFacing,
      });
      await onCreated();
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title={t("newTask")} onClose={onClose} testId="task-modal">
      <form onSubmit={submit}>
        <ErrorBanner error={error} />
        <Field label={t("taskTitle")}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} required data-testid="task-title" />
        </Field>
        <div className="row">
          <Field label={t("owner")}>
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} required data-testid="task-owner">
              <option value="">{t("choosePerson")}</option>
              {people.map((u) => (
                <option key={u.id} value={u.id}>
                  {label(u.displayName, u.displayNameKm)}
                  {memberIds.has(u.id) ? ` · ${project.members.find((m) => m.user_id === u.id)!.project_role}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("estimateHours")}>
            <input
              inputMode="decimal"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              aria-invalid={hours !== "" && minutes === null}
              placeholder="4"
              required
              data-testid="task-estimate"
            />
          </Field>
          <Field label={t("dueDate")}>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required data-testid="task-due" />
          </Field>
        </div>
        {client && (
          <fieldset className="roles" data-testid="task-link">
            <legend>{t("taskScopeLink")}</legend>
            {(["scope", "non_deliverable", "out_of_scope"] as const).map((k) => (
              <label key={k} className="check">
                <input
                  type="radio"
                  name="task-link"
                  checked={link === k}
                  onChange={() => setLink(k)}
                  data-testid={`task-link-${k}`}
                />
                {t(`taskLink.${k}`)}
              </label>
            ))}
            {link === "scope" && (
              <select
                value={scopeItemId}
                onChange={(e) => setScopeItemId(e.target.value)}
                data-testid="task-scope-item"
                aria-label={t("scopeItem")}
              >
                <option value="">{t("chooseScopeItem")}</option>
                {scope.data?.items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {label(it.description_en, it.description_km)} ({money(it.line_price_minor, scope.data!.currency)})
                  </option>
                ))}
              </select>
            )}
            {link === "out_of_scope" && (
              <>
                <p className="muted small">{t("oosHelp")}</p>
                <textarea
                  rows={2}
                  value={oosReason}
                  onChange={(e) => setOosReason(e.target.value)}
                  maxLength={1000}
                  aria-label={t("oosReason")}
                  placeholder={t("oosReason")}
                  data-testid="task-oos-reason"
                />
              </>
            )}
          </fieldset>
        )}
        {client && (
          <label className="check block">
            <input
              type="checkbox"
              checked={clientFacing}
              onChange={(e) => setClientFacing(e.target.checked)}
              data-testid="task-client-facing"
            />
            {t("clientFacingHint")}
          </label>
        )}
        {openTasks.length > 0 && (
          <details>
            <summary>{t("dependsOn")}</summary>
            {openTasks.map((x) => (
              <label key={x.id} className="check block">
                <input
                  type="checkbox"
                  checked={deps.includes(x.id)}
                  onChange={(e) => setDeps(e.target.checked ? [...deps, x.id] : deps.filter((d) => d !== x.id))}
                />
                {x.title}
              </label>
            ))}
          </details>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary" disabled={busy || !valid} data-testid="task-submit">
            {t("create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
