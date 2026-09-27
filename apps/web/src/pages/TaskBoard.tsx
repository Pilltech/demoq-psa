// Task Kanban (specs/tasks/tasks.md): per project (TaskBoard) and per person (MyTasks). Columns To do / In progress /
// Done; move with the buttons on a card (phones, keyboards) or by dragging. Each card says what blocks it: missing
// gates (PRJ-GT-04), open dependencies (TSK-TK-04), a pending out-of-scope decision (TSK-TK-02) or a closed project.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type DragEvent, type FormEvent } from "react";
import { ApiError, hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field, Modal } from "../components/ui";
import { addDaysIso, formatMinutes, parseHours, phnomPenhToday } from "../format";
import { useI18n } from "../i18n";
import { useDirectory, useProjects, useScope } from "../queries";
import { Link } from "../router";
import type { Gate, ProjectDetail, ProjectStatus, Task, TaskBoardData, TaskStatus } from "../types";

type Column = Exclude<TaskStatus, "cancelled">;
const COLUMNS: Column[] = ["todo", "in_progress", "done"];
/** TSK-TK-03: the moves an owner can make. */
const MOVES: Record<Column, Column[]> = { todo: ["in_progress"], in_progress: ["done", "todo"], done: [] };

/** What the board knows about a task's project, to explain why a card cannot start. */
interface ProjectInfo {
  kind: "client" | "internal";
  status: ProjectStatus;
  uncovered: Gate[];
}

/** A refused move. GATE_BLOCKED lists the gates still missing (from the error, else from the project itself). */
interface MoveError {
  error: unknown;
  gates: Gate[] | null;
}

function useMover(onDone: () => Promise<unknown>) {
  const [moveError, setMoveError] = useState<MoveError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const move = async (task: Task, to: Column) => {
    setBusy(task.id);
    setMoveError(null);
    try {
      await op("task.move", { id: task.id, expectedVersion: task.version, to });
      await onDone();
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
      setMoveError({ error: e, gates });
      if (e instanceof ApiError && e.code === "STALE_VERSION") await onDone();
    } finally {
      setBusy(null);
    }
  };
  return { move, moveError, busy, clear: () => setMoveError(null) };
}

function MoveErrorBanner({ e }: { e: MoveError | null }) {
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

export function TaskBoard({ project, me }: { project: ProjectDetail; me: Me }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const board = useQuery({
    queryKey: ["task-board", project.id],
    queryFn: () => op<TaskBoardData>("task.board", { projectId: project.id }),
  });
  const refresh = () =>
    Promise.all(
      [["task-board", project.id], ["project", project.id], ["my-tasks"]].map((k) => qc.invalidateQueries({ queryKey: k })),
    );
  const { move, moveError, busy } = useMover(refresh);
  const [creating, setCreating] = useState(false);
  const [cancelError, setCancelError] = useState<unknown>(null);
  const info: ProjectInfo = { kind: project.kind, status: project.status, uncovered: project.gateStatus.uncovered };
  const open = ["gated", "active", "on_hold"].includes(project.status);
  const cancel = async (task: Task) => {
    setCancelError(null);
    try {
      await op("task.cancel", { id: task.id, expectedVersion: task.version });
      await refresh();
    } catch (e) {
      setCancelError(e);
    }
  };
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
      <MoveErrorBanner e={moveError} />
      <ErrorBanner error={board.error ?? cancelError} />
      {board.isLoading && <p>{t("loading")}</p>}
      {board.data && (
        <Kanban
          tasks={board.data.tasks}
          projectInfo={() => info}
          canMove={(task) => !!task.canMove}
          onMove={move}
          busy={busy}
          onCancel={board.data.canManage && open ? cancel : undefined}
        />
      )}
      {creating && board.data && (
        <NewTaskModal project={project} board={board.data} me={me} onClose={() => setCreating(false)} onCreated={refresh} />
      )}
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
    Promise.all([["my-tasks"], ["task-board"], ["project"]].map((k) => qc.invalidateQueries({ queryKey: k })));
  const { move, moveError, busy } = useMover(refresh);
  const infoFor = (task: Task): ProjectInfo | undefined => {
    const p = projects.data?.find((x) => x.id === task.project_id);
    return p ? { kind: p.kind, status: p.status, uncovered: p.missingGates } : undefined;
  };
  const mayMove = hasPerm(me, "task.move_own");
  // Only people who manage tasks look at someone else's board.
  const pickPerson = hasPerm(me, "task.manage") && !!users.data;
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
      <MoveErrorBanner e={moveError} />
      <ErrorBanner error={tasks.error} />
      {tasks.isLoading && <p>{t("loading")}</p>}
      {tasks.data && (
        <Kanban
          tasks={tasks.data}
          projectInfo={infoFor}
          canMove={(task) => mayMove && task.owner_id === me.id}
          onMove={move}
          busy={busy}
          showProject
        />
      )}
    </section>
  );
}

// ---- The board itself ------------------------------------------------------------------------

function Kanban({
  tasks,
  projectInfo,
  canMove,
  onMove,
  busy,
  onCancel,
  showProject = false,
}: {
  tasks: Task[];
  projectInfo: (t: Task) => ProjectInfo | undefined;
  canMove: (t: Task) => boolean;
  onMove: (t: Task, to: Column) => void;
  busy: string | null;
  onCancel?: (t: Task) => void;
  showProject?: boolean;
}) {
  const { t } = useI18n();
  const [over, setOver] = useState<Column | null>(null);
  const onDrop = (e: DragEvent, to: Column) => {
    e.preventDefault();
    setOver(null);
    const task = tasks.find((x) => x.id === e.dataTransfer.getData("text/task-id"));
    if (task && task.status !== "cancelled" && MOVES[task.status].includes(to) && canMove(task)) onMove(task, to);
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
                movable={canMove(task)}
                onMove={onMove}
                busy={busy === task.id}
                onCancel={onCancel}
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
  movable,
  onMove,
  busy,
  onCancel,
  showProject,
}: {
  task: Task;
  all: Task[];
  info: ProjectInfo | undefined;
  movable: boolean;
  onMove: (t: Task, to: Column) => void;
  busy: boolean;
  onCancel?: (t: Task) => void;
  showProject: boolean;
}) {
  const { t } = useI18n();
  const col = task.status as Column;
  const today = phnomPenhToday();
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
  return (
    <article
      className={`deal-card task-card${blocked.length ? " blocked" : ""}`}
      draggable={movable && col !== "done"}
      onDragStart={(e) => e.dataTransfer.setData("text/task-id", task.id)}
      data-testid={`task-${task.id}`}
      data-title={task.title}
      data-status={task.status}
    >
      <div className="title">{task.title}</div>
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
      {blocked.length > 0 && (
        <ul className="blocked-list" data-testid="task-blocked">
          {blocked.map((b) => (
            <li key={b.key} data-reason={b.key}>
              {b.text}
            </li>
          ))}
        </ul>
      )}
      {(movable || onCancel) && col !== "done" && (
        <div className="task-actions">
          {movable &&
            MOVES[col].map((to) => (
              <button
                key={to}
                className={to === "todo" ? "" : "primary"}
                disabled={busy}
                onClick={() => onMove(task, to)}
                data-testid={`task-move-${to}`}
              >
                {t(`taskMove.${to}`)}
              </button>
            ))}
          {onCancel && (
            <button className="link small" disabled={busy} onClick={() => onCancel(task)} data-testid="task-cancel">
              {t("cancelTask")}
            </button>
          )}
        </div>
      )}
    </article>
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
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const minutes = parseHours(hours);
  const linkOk = !client || (link === "scope" ? !!scopeItemId : link === "out_of_scope" ? oosReason.trim().length > 0 : true);
  const valid = title.trim() && ownerId && minutes && dueDate && linkOk;
  // Members first (they are who the work is for), then everyone else.
  const memberIds = new Set(project.members.map((m) => m.user_id));
  const people = [...(users.data ?? [])].sort((a, b) => Number(memberIds.has(b.id)) - Number(memberIds.has(a.id)));
  const openTasks = board.tasks.filter((x) => x.status === "todo" || x.status === "in_progress" || x.status === "done");

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
