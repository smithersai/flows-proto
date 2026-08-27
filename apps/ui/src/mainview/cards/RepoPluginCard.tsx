/*
 * The repo-plugin card (docs/LOCAL-APP.md "Plugin manifest"): the
 * repository's parsed `.smithers/UI.json` as group sections of entries, each
 * with its workspace, approval, agentic and kind badges and one Run button
 * riding the existing `target.run` flow. Embedded like every card (EMBED
 * LAW); maximizing is the user's act on the card chrome.
 */
import { Button, EmptyState, StatusPill } from "@smthrs/ui"
import type { Card } from "../state/AppState"

export const RepoPluginCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "repo-plugin" }>
  readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const { repoId, manifest } = card.payload
  return (
    <div className="repo-plugin-card">
      <p className="repo-plugin-summary">{manifest.summary}</p>
      {manifest.groups.length === 0 ?
        <EmptyState title="No plugin groups" description={`${manifest.name} declares no groups.`} /> :
        null}
      {manifest.groups.map((group) => {
        const entries = manifest.entries.filter((entry) => entry.group === group.id)
        return (
          <section key={group.id} className="repo-plugin-group" data-group={group.id}>
            <h3 className="repo-plugin-group-title">{group.title}</h3>
            {entries.length === 0 ?
              <EmptyState title="No entries" description={`${group.title} has no entries.`} /> :
              (
                <ul className="repo-plugin-list">
                  {entries.map((entry) => (
                    <li key={entry.id} className="repo-plugin-row" data-plugin-entry={entry.id}>
                      <div className="repo-plugin-row-head">
                        <span className="repo-plugin-row-title">{entry.title}</span>
                        <span className="repo-plugin-badges">
                          <StatusPill status="muted" label={entry.workspace} withDot={false} data-badge="workspace" />
                          <StatusPill status="muted" label={group.kind} withDot={false} data-badge="kind" />
                          <StatusPill
                            status={entry.approval ? "warn" : "muted"}
                            label={entry.approval ? "approval" : "no approval"}
                            withDot={false}
                            data-badge="approval"
                          />
                          <StatusPill
                            status={entry.agentic ? "run" : "muted"}
                            label={entry.agentic ? "agentic" : "non-agentic"}
                            withDot={false}
                            data-badge="agentic"
                          />
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          data-flow="target.run"
                          data-testid={`plugin-run-${entry.id}`}
                          onClick={() => onRunCommand("target.run", `${repoId} ${entry.workspace} ${entry.label}`)}
                        >
                          Run
                        </Button>
                      </div>
                      <p className="repo-plugin-row-summary">{entry.summary}</p>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        )
      })}
    </div>
  )
}
