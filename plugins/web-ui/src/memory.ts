import { html, nothing, render, type TemplateResult } from "lit";
import { ChevronLeft, Clock3, Pencil, RefreshCw, Search, Trash2 } from "lucide";
import { api, ApiError } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { appState, replacePanePreservingFocus } from "./shell";

interface RevisionRow {
  revision: string;
  content: string;
  operation: string;
  author?: string;
  at: number;
}

let memoryDraft = "";
let memorySaved = "";
let memoryRevision = "";
let memoryNotice = "";
let memorySaving = false;
let memoryLoaded = false;
let rawEditing = true;
let search = "";
let historyOpen = false;
let history: RevisionRow[] = [];
let memoryConfirmation: { title: string; body: string; action: string; run: () => Promise<void> } | null = null;
let memoryScope = "";
let memoryTab: "mine" | "projects" = "mine";
let projectScopes: Array<{ scopeId: string; name: string }> = [];
let projectFactCounts = new Map<string, number>();
let projectsLoading = false;

export function resetMemoryState(): void {
  memoryDraft = "";
  memorySaved = "";
  memoryRevision = "";
  memoryNotice = "";
  memorySaving = false;
  memoryLoaded = false;
  rawEditing = true;
  search = "";
  historyOpen = false;
  history = [];
  memoryConfirmation = null;
  memoryScope = "";
  memoryTab = "mine";
  projectScopes = [];
  projectFactCounts = new Map();
  projectsLoading = false;
}

function ownNotebook(): boolean {
  return memoryScope === "";
}

function scopeQuery(): string {
  return memoryScope ? `?scope=${encodeURIComponent(memoryScope)}` : "";
}

function scopeName(): string {
  return projectScopes.find((p) => p.scopeId === memoryScope)?.name ?? "this project";
}

async function loadProjectScopes(): Promise<void> {
  const r = await api<{
    contexts?: Array<{ scopeId?: string; kind?: string; project?: { name?: string } | null }>;
  }>("/api/contexts");
  projectScopes = (r.contexts ?? []).flatMap((c) =>
    c.kind === "group" && c.scopeId && c.project?.name ? [{ scopeId: c.scopeId, name: c.project.name }] : [],
  );
}

async function loadProjectFactCounts(): Promise<void> {
  const counts = await Promise.all(
    projectScopes.map(async (p) => {
      const r = await api<{ content?: string }>(`/api/memory?scope=${encodeURIComponent(p.scopeId)}`).catch(() => null);
      return [p.scopeId, r ? facts(r.content ?? "").length : -1] as const;
    }),
  );
  projectFactCounts = new Map(counts);
}

function goTo(tab: "mine" | "projects", scopeId = ""): void {
  if (tab === memoryTab && scopeId === memoryScope) return;
  const move = () => {
    memoryTab = tab;
    memoryScope = scopeId;
    memoryDraft = "";
    memorySaved = "";
    memoryRevision = "";
    memoryLoaded = false;
    history = [];
    historyOpen = false;
    search = "";
    memoryConfirmation = null;
    void renderMemory(true);
  };
  if (memoryLoaded && ownNotebook() && memoryDraft !== memorySaved) {
    memoryConfirmation = {
      title: "Discard unsaved memory changes?",
      body: "Leaving your notebook will drop this draft. Copy anything you want to keep before continuing.",
      action: "Discard and leave",
      run: async () => move(),
    };
    return void drawMemory();
  }
  move();
}

function facts(content: string): Fact[] {
  return content.split("\n").flatMap((row, line) => {
    const match = row.match(/^\s*[-*]\s+(?:\((\d{4}-\d{2}-\d{2})\)\s*)?(.*\S)\s*$/);
    return match ? [{ line, ...(match[1] ? { date: match[1] } : {}), text: match[2]! }] : [];
  });
}

function removeFact(line: number): void {
  const lines = memoryDraft.split("\n");
  lines.splice(line, 1);
  memoryDraft = lines.join("\n");
  drawMemory();
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

type Fact = { line: number; text: string; date?: string };

function notebookBody(loading: boolean, visible: Fact[]): TemplateResult {
  if (!ownNotebook()) {
    return html`<textarea class="memory-text" spellcheck="false" readonly .value=${memorySaved}></textarea>`;
  }
  if (rawEditing) {
    return html`<textarea
      class="memory-text"
      data-focus-key="memory-raw"
      spellcheck="false"
      ?disabled=${loading || memorySaving}
      @input=${(e: Event) => {
        memoryDraft = (e.target as HTMLTextAreaElement).value;
        drawMemory();
      }}
      .value=${memoryDraft}
    ></textarea>`;
  }
  return html` <label class="memory-search"
      >${icon(Search, 16)}<input
        data-focus-key="memory-search"
        aria-label="Search memory"
        type="search"
        placeholder="Search remembered facts"
        .value=${search}
        @input=${(e: Event) => {
          search = (e.target as HTMLInputElement).value;
          drawMemory();
        }}
    /></label>
    <div class="memory-facts">
      ${
        visible.length
          ? visible.map(
              (fact) =>
                html`<div class="memory-fact">
                  <div>
                    <div>${fact.text}</div>
                    ${fact.date ? html`<div class="card-meta">Captured ${fact.date}</div>` : nothing}
                  </div>
                  <button
                    class="icon-btn"
                    type="button"
                    aria-label="Forget this fact"
                    title="Forget this fact"
                    @click=${() => removeFact(fact.line)}
                  >
                    ${icon(Trash2, 15)}
                  </button>
                </div>`,
            )
          : html`<div class="empty-state">
              ${search ? "No remembered facts match this search." : "The agent hasn’t noted any facts yet."}
            </div>`
      }
    </div>`;
}

function showingNotebook(): boolean {
  return memoryTab === "mine" || memoryScope !== "";
}

function subtitle(): string {
  if (memoryTab === "mine") return "Facts the agent carries into your conversations.";
  if (!memoryScope) return "Notebooks shared by the projects you belong to.";
  return `Facts every member of ${scopeName()} shares. Your own memory stays private to you.`;
}

function factCountLabel(count: number | undefined): string {
  if (count === undefined) return "Counting facts…";
  if (count < 0) return "Could not be read";
  if (count === 0) return "Nothing remembered yet";
  return count === 1 ? "1 remembered fact" : `${count} remembered facts`;
}

function projectListPane(): TemplateResult {
  if (projectsLoading && !projectScopes.length) return html`<div class="empty-state">Loading your projects…</div>`;
  if (!projectScopes.length) {
    return html`<div class="empty-state">
      You are not in any projects yet. A project gets its own notebook as soon as its chats have something worth
      remembering.
    </div>`;
  }
  return html`<p class="memory-help">
      Every project you belong to keeps its own notebook, written as that project's chats happen. Open one to read it.
      Your own memory stays separate and private to you.
    </p>
    <div class="memory-facts">
      ${projectScopes.map((p) => {
        const count = projectFactCounts.get(p.scopeId);
        return html`<div class="memory-fact">
          <div>
            <div>${p.name}</div>
            <div class="card-meta">${factCountLabel(count)}</div>
          </div>
          <button class="btn" type="button" @click=${() => goTo("projects", p.scopeId)}>Open</button>
        </div>`;
      })}
    </div>`;
}

function notebookPane(loading: boolean, visible: Fact[], dirty: boolean): TemplateResult {
  return html`${
      memoryScope
        ? html`<div class="actions">
            <button class="btn" type="button" @click=${() => goTo("projects")}>
              ${icon(ChevronLeft, 15)} All projects
            </button>
          </div>`
        : nothing
    }
    <p class="memory-help">
      ${
        ownNotebook()
          ? "Edit the notebook directly. Switch to Facts view to search or remove individual facts. Saves are protected if the agent remembers something new while this page is open."
          : html`Read-only here. A project notebook is written by the agent as that project's chats happen, so it is not
            edited by hand — and editing it from this page would silently write to your own memory instead.`
      }
    </p>
    ${notebookBody(loading, visible)}
    ${
      ownNotebook()
        ? html`<div class="memory-actions">
            <button
              class="btn primary memory-save"
              type="button"
              ?disabled=${loading || memorySaving || !dirty}
              @click=${() => void saveMemory()}
            >
              ${memorySaving ? "Saving…" : "Save changes"}
            </button>
            <span class="memory-hint">${dirty && !memorySaving ? "Unsaved changes" : ""}</span>
          </div>`
        : nothing
    }`;
}

function drawMemory(loading = false): void {
  if (appState.currentView !== "memory" || !appState.mainEl) return;
  const dirty = memoryDraft !== memorySaved;
  const visible = facts(memoryDraft).filter(
    (fact) => !search || fact.text.toLowerCase().includes(search.toLowerCase()),
  );
  const host = document.createElement("div");
  host.className = "pane";
  render(
    html`
      <div class="pane-head">
        <div>
          <h1 class="pane-title">Memory</h1>
          <div class="pane-subtitle">${subtitle()}</div>
        </div>
        <div class="pane-head-actions">
          ${
            memoryTab === "mine"
              ? html`<button
                  class="btn"
                  type="button"
                  @click=${() => {
                    rawEditing = !rawEditing;
                    drawMemory();
                  }}
                >
                  ${icon(Pencil, 15)} ${rawEditing ? "Facts view" : "Edit notebook"}
                </button>`
              : nothing
          }
          ${
            showingNotebook()
              ? html`<button class="btn" type="button" @click=${() => void toggleHistory()}>
                  ${icon(Clock3, 15)} History
                </button>`
              : nothing
          }
          <button
            class="pane-refresh"
            type="button"
            aria-label="Refresh memory"
            title="Refresh memory"
            @click=${() => void renderMemory(true)}
          >
            ${icon(RefreshCw, 17)}
          </button>
        </div>
      </div>
      ${memoryNotice || loading ? html`<div class="status">${memoryNotice || "Loading…"}</div>` : nothing}
      <div class="actions">
        <button class="btn ${memoryTab === "mine" ? "primary" : ""}" type="button" @click=${() => goTo("mine")}>
          My memory
        </button>
        <button class="btn ${memoryTab === "projects" ? "primary" : ""}" type="button" @click=${() => goTo("projects")}>
          Projects memory
        </button>
      </div>
      <div class="memory-editor">
        ${showingNotebook() ? notebookPane(loading, visible, dirty) : projectListPane()}
        ${
          historyOpen && showingNotebook()
            ? html` <section class="memory-history">
                <h2>Revision history</h2>
                ${
                  history.length
                    ? history.map(
                        (row, i) =>
                          html` <div class="memory-revision">
                            <div>
                              <strong>${i === 0 ? "Current" : `Revision ${row.revision}`}</strong>
                              <div class="card-meta">
                                ${fmtDate(row.at)} · ${row.author || "automatic capture"} · ${row.operation}
                              </div>
                            </div>
                            ${i && ownNotebook() ? html`<button class="btn" type="button" @click=${() => requestRestoreRevision(row)}>Restore</button>` : nothing}
                          </div>`,
                      )
                    : html`<div class="empty-state">Revision history is unavailable for this memory store.</div>`
                }
              </section>`
            : nothing
        }
        ${
          memoryConfirmation
            ? html` <section class="card memory-confirm" role="alertdialog" aria-labelledby="memory-confirm-title">
                <div class="card-head">
                  <h2 class="card-title" id="memory-confirm-title">${memoryConfirmation.title}</h2>
                  <span class="badge warn">Check impact</span>
                </div>
                <p class="memory-help">${memoryConfirmation.body}</p>
                <div class="actions">
                  <button class="btn danger" type="button" @click=${() => void memoryConfirmation?.run()}>
                    ${memoryConfirmation.action}</button
                  ><button
                    class="btn"
                    type="button"
                    @click=${() => {
                      memoryConfirmation = null;
                      drawMemory();
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </section>`
            : nothing
        }
      </div>
    `,
    host,
  );
  replacePanePreservingFocus(host);
}

export async function renderMemory(force = false): Promise<void> {
  if (appState.currentView !== "memory") return;
  const dirty = memoryLoaded && memoryDraft !== memorySaved;
  if (dirty && !force) return void drawMemory();
  if (dirty && force) {
    memoryConfirmation = {
      title: "Discard unsaved memory changes?",
      body: "Refreshing will replace this draft with the latest memory. Copy anything you want to keep before continuing.",
      action: "Discard and refresh",
      run: async () => {
        memoryConfirmation = null;
        memoryDraft = memorySaved;
        await renderMemory(true);
      },
    };
    return void drawMemory();
  }
  const seq = appState.viewRenderSeq;
  memoryNotice = "";
  drawMemory(true);
  projectsLoading = true;
  try {
    await loadProjectScopes();
  } catch (e) {
    memoryNotice = errMessage(e, "Failed to list your projects; showing your own memory only.");
  } finally {
    projectsLoading = false;
  }
  if (memoryScope && !projectScopes.some((p) => p.scopeId === memoryScope)) memoryScope = "";
  if (!showingNotebook()) {
    if (seq !== appState.viewRenderSeq || appState.currentView !== "memory") return;
    drawMemory();
    await loadProjectFactCounts();
    if (seq !== appState.viewRenderSeq || appState.currentView !== "memory") return;
    return void drawMemory();
  }
  try {
    const r = await api<{ content?: string; revision?: string }>(`/api/memory${scopeQuery()}`);
    if (seq !== appState.viewRenderSeq || appState.currentView !== "memory") return;
    memorySaved = r.content ?? "";
    memoryDraft = memorySaved;
    memoryRevision = r.revision ?? "";
    memoryLoaded = true;
  } catch (e) {
    if (seq !== appState.viewRenderSeq || appState.currentView !== "memory") return;
    memoryNotice = errMessage(e, "Failed to load memory.");
  }
  drawMemory();
}

async function saveMemory(): Promise<void> {
  if (memorySaving) return;
  memorySaving = true;
  memoryNotice = "";
  drawMemory();
  try {
    const r = await api<{ content?: string; revision?: string }>("/api/memory", {
      method: "PUT",
      body: JSON.stringify({ content: memoryDraft, revision: memoryRevision }),
    });
    memorySaved = r.content ?? memoryDraft;
    memoryDraft = memorySaved;
    memoryRevision = r.revision ?? memoryRevision;
    memoryNotice = "Saved ✓";
    if (historyOpen) {
      try {
        await loadHistory();
      } catch {
        memoryNotice = "Saved ✓ History could not refresh.";
      }
    }
  } catch (e) {
    memoryNotice =
      e instanceof ApiError && e.status === 409
        ? "Memory changed in another conversation. Your draft is still here; copy it if needed, then refresh to merge with the latest version."
        : errMessage(e, "Failed to save memory.");
  } finally {
    memorySaving = false;
    drawMemory();
  }
}

async function loadHistory(): Promise<void> {
  const r = await api<{ revisions?: RevisionRow[] }>(`/api/memory/history${scopeQuery()}`);
  history = r.revisions ?? [];
}

async function toggleHistory(): Promise<void> {
  historyOpen = !historyOpen;
  if (historyOpen) {
    try {
      await loadHistory();
    } catch (e) {
      memoryNotice = errMessage(e, "Failed to load memory history.");
    }
  }
  drawMemory();
}

function requestRestoreRevision(row: RevisionRow): void {
  memoryConfirmation = {
    title: `Restore memory from ${fmtDate(row.at)}?`,
    body: "The selected notebook will become current. The version you have now remains available in history.",
    action: "Restore revision",
    run: async () => {
      memoryConfirmation = null;
      await restoreRevision(row);
    },
  };
  drawMemory();
}

async function restoreRevision(row: RevisionRow): Promise<void> {
  try {
    const r = await api<{ content?: string; revision?: string }>("/api/memory/restore", {
      method: "POST",
      body: JSON.stringify({ revision: row.revision, expectedRevision: memoryRevision }),
    });
    memorySaved = r.content ?? "";
    memoryDraft = memorySaved;
    memoryRevision = r.revision ?? memoryRevision;
    memoryNotice = "Revision restored ✓";
    try {
      await loadHistory();
    } catch {
      memoryNotice = "Revision restored ✓ History could not refresh.";
    }
  } catch (e) {
    memoryNotice = errMessage(e, "Could not restore that revision.");
  }
  drawMemory();
}
