// Projects list (specs/projects/projects.md): mine (PM or member) or everyone's, with status and the gates that still
// block work (missing and not covered by an open bypass).
import { useState } from "react";
import { type Me } from "../api";
import { ErrorBanner, GateChips, ProjectStatusBadge } from "../components/ui";
import { useI18n } from "../i18n";
import { useProjects } from "../queries";
import { Link } from "../router";

export function Projects({ me }: { me: Me }) {
  const { t } = useI18n();
  const [mine, setMine] = useState(true);
  const [includeClosed, setIncludeClosed] = useState(false);
  const projects = useProjects(me, mine, includeClosed);
  return (
    <section>
      <div className="toolbar">
        <h1>{t("projects")}</h1>
        <div className="segmented" role="tablist">
          {([true, false] as const).map((m) => (
            <button
              key={String(m)}
              role="tab"
              aria-selected={mine === m}
              className={mine === m ? "active" : ""}
              onClick={() => setMine(m)}
              data-testid={m ? "projects-mine" : "projects-all"}
            >
              {t(m ? "projectsMine" : "projectsAll")}
            </button>
          ))}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.target.checked)}
            data-testid="projects-closed"
          />
          {t("includeClosed")}
        </label>
      </div>
      <ErrorBanner error={projects.error} />
      {projects.isLoading && <p>{t("loading")}</p>}
      {projects.data && projects.data.length === 0 && <p className="muted">{t("noProjects")}</p>}
      <ul className="list project-list" data-testid="project-list">
        {projects.data?.map((p) => (
          <li key={p.id} className="card project-row" data-testid={`project-row-${p.id}`} data-name={p.name}>
            <div className="project-row-main">
              <Link to={`/projects/${p.id}`} testId="project-link">
                <strong>{p.name}</strong>
              </Link>
              <span className="muted small">
                {p.client_name ?? t("internalProject")} · {t("pmIs", { who: p.pm_name })} ·{" "}
                {t("startsOn", { date: p.planned_start })}
              </span>
            </div>
            <div className="project-row-status">
              <ProjectStatusBadge status={p.status} testId="project-row-status" />
              <GateChips gates={p.missingGates} testId="project-row-gates" />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
