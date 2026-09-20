import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import "./styles.css";

type User = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  mfaRequired: boolean;
};

type Preview = {
  interpreted: {
    definition: Record<string, unknown>;
    summary: string;
    clarificationQuestions: string[];
    warnings: string[];
    confidence: number;
  };
  originalRequest: string;
  provider: string;
  model: string;
  promptVersion: string;
  requestId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

type Task = {
  id: string;
  name: string;
  status: string;
  currentRevision: number;
  summary: string;
  clarificationQuestions: string[];
  provider: string;
  model: string;
};

type CollectionRun = {
  id: string;
  taskRevision: number | null;
  trigger: string;
  status: string;
  attempt: number;
  fetchedCount: number;
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
  rejectedCount: number;
  analysisStatus: string;
  candidateCount: number;
  eventCount: number;
  analysisErrorCode: string | null;
  analysisErrorMessage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
};

type Evidence = { sourceField: string; quote: string };

type InboxEvent = {
  id: string;
  eventType: string;
  state: "unread" | "read" | "archived";
  severity: string;
  title: string;
  summary: string;
  reason: string;
  evidence: Evidence[];
  occurredAt: string;
  createdAt: string;
  taskId: string;
  taskName: string;
  canonicalUrl: string | null;
  score: number | string;
  provider: string;
  model: string;
  feedbackRating: string | null;
};

type EventDetail = InboxEvent & {
  facts: Array<{ name: string; value: string; confidence: number }>;
  uncertainties: string[];
  promptVersion: string;
  normalized: { content?: string; [key: string]: unknown };
  feedbackNote: string | null;
};

type NotificationSettings = {
  email: { enabled: boolean; from: string };
  digestTime: string;
  quietHours: { enabled: boolean; start: string; end: string };
};

function cookie(name: string): string | undefined {
  return document.cookie
    .split("; ")
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  const csrf = cookie("chitanda_csrf");
  if (csrf) headers.set("x-csrf-token", decodeURIComponent(csrf));
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

function AuthScreen({
  bootstrap,
  onAuthenticated
}: {
  bootstrap: boolean;
  onAuthenticated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (bootstrap) {
        await api("/api/auth/bootstrap", {
          method: "POST",
          headers: { "x-bootstrap-token": bootstrapToken },
          body: JSON.stringify({ email, displayName, password })
        });
      } else {
        await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password, ...(totp ? { totp } : {}) })
        });
      }
      onAuthenticated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登入失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="panel auth-panel">
      <p class="kicker">{bootstrap ? "FIRST-RUN SETUP" : "WELCOME BACK"}</p>
      <h2>{bootstrap ? "建立管理者" : "登入 Chitanda"}</h2>
      <p class="muted">
        {bootstrap ? "使用 .secrets/bootstrap-token 中的一次性權杖。" : "使用本機帳號登入。"}
      </p>
      <form onSubmit={(event) => void submit(event)}>
        {bootstrap && (
          <label>
            Bootstrap token
            <input
              type="password"
              required
              value={bootstrapToken}
              onInput={(e) => setBootstrapToken(e.currentTarget.value)}
            />
          </label>
        )}
        {bootstrap && (
          <label>
            顯示名稱
            <input
              required
              maxLength={100}
              value={displayName}
              onInput={(e) => setDisplayName(e.currentTarget.value)}
            />
          </label>
        )}
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </label>
        <label>
          密碼
          <input
            type="password"
            minLength={bootstrap ? 12 : 1}
            required
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </label>
        {!bootstrap && (
          <label>
            TOTP（若已啟用）
            <input
              inputMode="numeric"
              pattern="[0-9]{6}"
              value={totp}
              onInput={(e) => setTotp(e.currentTarget.value)}
            />
          </label>
        )}
        {error && <p class="error">{error}</p>}
        <button disabled={busy}>{busy ? "處理中…" : bootstrap ? "建立帳號" : "登入"}</button>
      </form>
    </section>
  );
}

function MfaSetup({ user, onComplete }: { user: User; onComplete: () => void }) {
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  async function setup(): Promise<void> {
    setError("");
    try {
      const result = await api<{ secret: string; uri: string }>("/api/auth/mfa/setup", {
        method: "POST"
      });
      setSecret(result.secret);
      setUri(result.uri);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法建立 TOTP");
    }
  }

  async function confirm(event: Event): Promise<void> {
    event.preventDefault();
    try {
      await api("/api/auth/mfa/confirm", { method: "POST", body: JSON.stringify({ token }) });
      onComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "驗證失敗");
    }
  }

  return (
    <section class="panel auth-panel">
      <p class="kicker">SECURITY CHECKPOINT</p>
      <h2>設定管理者 TOTP</h2>
      <p class="muted">{user.email} 必須完成第二因素驗證，才能建立或啟用監測任務。</p>
      {!secret ? (
        <button onClick={() => void setup()}>產生 TOTP 密鑰</button>
      ) : (
        <form onSubmit={(event) => void confirm(event)}>
          <label>
            手動輸入密鑰
            <input
              class="mono"
              readOnly
              value={secret}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <details>
            <summary>顯示 otpauth URI</summary>
            <code class="uri">{uri}</code>
          </details>
          <label>
            驗證器顯示的 6 位數代碼
            <input
              required
              inputMode="numeric"
              pattern="[0-9]{6}"
              value={token}
              onInput={(e) => setToken(e.currentTarget.value)}
            />
          </label>
          <button>完成設定</button>
        </form>
      )}
      {error && <p class="error">{error}</p>}
    </section>
  );
}

function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [request, setRequest] = useState(
    "追蹤新加坡未來六個月的演唱會，公布新場次時透過 Email 通知我。"
  );
  const [provider, setProvider] = useState("ollama");
  const [preview, setPreview] = useState<Preview>();
  const [definitionText, setDefinitionText] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Record<string, CollectionRun[]>>({});
  const [events, setEvents] = useState<InboxEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<EventDetail>();
  const [openRuns, setOpenRuns] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>();

  async function loadTasks(): Promise<void> {
    const result = await api<{ tasks: Task[] }>("/api/tasks");
    setTasks(result.tasks);
  }

  async function loadEvents(): Promise<void> {
    const result = await api<{ events: InboxEvent[] }>("/api/events?limit=50");
    setEvents(result.events);
  }

  useEffect(() => {
    void loadTasks().catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "載入失敗")
    );
    void loadEvents().catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "載入 Inbox 失敗")
    );
    void api<NotificationSettings>("/api/settings/notifications")
      .then(setNotificationSettings)
      .catch(() => undefined);
  }, []);

  async function loadSingaporeConcertTemplate(): Promise<void> {
    setBusy(true);
    setMessage("");
    try {
      const result = await api<Preview>(
        `/api/tasks/templates/singapore-concerts?provider=${encodeURIComponent(provider)}`
      );
      setRequest(result.originalRequest);
      setPreview(result);
      setDefinitionText(JSON.stringify(result.interpreted.definition, null, 2));
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "無法載入範本");
    } finally {
      setBusy(false);
    }
  }

  async function sendTestEmail(): Promise<void> {
    setBusy(true);
    setMessage("");
    try {
      await api("/api/settings/notifications/email/test", { method: "POST" });
      setMessage(`測試信已寄到 ${user.email}。`);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "測試信寄送失敗");
    } finally {
      setBusy(false);
    }
  }

  async function openEvent(id: string): Promise<void> {
    try {
      const result = await api<{ event: EventDetail }>(`/api/events/${id}`);
      setSelectedEvent(result.event);
      if (result.event.state === "unread") await setEventState(id, "read", false);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "載入事件失敗");
    }
  }

  async function setEventState(
    id: string,
    state: "unread" | "read" | "archived",
    reload = true
  ): Promise<void> {
    await api(`/api/events/${id}/state`, { method: "POST", body: JSON.stringify({ state }) });
    if (reload) await loadEvents();
    else {
      setEvents((current) =>
        current.map((event) => (event.id === id ? { ...event, state } : event))
      );
    }
  }

  async function sendFeedback(
    id: string,
    rating: "useful" | "irrelevant" | "duplicate"
  ): Promise<void> {
    try {
      await api(`/api/events/${id}/feedback`, {
        method: "POST",
        body: JSON.stringify({ rating, note: null })
      });
      setEvents((current) =>
        current.map((event) => (event.id === id ? { ...event, feedbackRating: rating } : event))
      );
      if (selectedEvent?.id === id) setSelectedEvent({ ...selectedEvent, feedbackRating: rating });
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "回饋儲存失敗");
    }
  }

  async function interpret(event: Event): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await api<Preview>("/api/tasks/interpret", {
        method: "POST",
        body: JSON.stringify({ request, provider, locale: "zh-TW", timezone: "Asia/Singapore" })
      });
      setPreview(result);
      setDefinitionText(JSON.stringify(result.interpreted.definition, null, 2));
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "解析失敗");
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setMessage("");
    try {
      const definition = JSON.parse(definitionText) as Record<string, unknown>;
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          preview: { ...preview, interpreted: { ...preview.interpreted, definition } }
        })
      });
      setPreview(undefined);
      setDefinitionText("");
      setMessage("草稿已儲存；確認沒有澄清問題後可啟用。");
      await loadTasks();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  async function activate(id: string): Promise<void> {
    try {
      await api(`/api/tasks/${id}/activate`, { method: "POST" });
      await loadTasks();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "啟用失敗");
    }
  }

  async function pause(id: string): Promise<void> {
    try {
      await api(`/api/tasks/${id}/pause`, { method: "POST" });
      await loadTasks();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "暫停失敗");
    }
  }

  async function runNow(id: string): Promise<void> {
    try {
      await api(`/api/tasks/${id}/run`, { method: "POST" });
      setMessage("收集工作已排入佇列。");
      await loadRuns(id);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "排程失敗");
    }
  }

  async function loadRuns(id: string): Promise<void> {
    const result = await api<{ runs: CollectionRun[] }>(`/api/tasks/${id}/runs`);
    setRuns((current) => ({ ...current, [id]: result.runs }));
  }

  async function retryRun(taskId: string, runId: string): Promise<void> {
    try {
      await api(`/api/tasks/${taskId}/runs/${runId}/retry`, { method: "POST" });
      setMessage("重試工作已排入佇列。");
      await loadRuns(taskId);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "重試失敗");
    }
  }

  async function toggleRuns(id: string): Promise<void> {
    if (openRuns === id) {
      setOpenRuns(undefined);
      return;
    }
    setOpenRuns(id);
    try {
      await loadRuns(id);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "載入 runs 失敗");
    }
  }

  return (
    <div class="workspace">
      <header class="topbar">
        <div>
          <span class="brand">Chitanda</span>
          <span class="phase">Phase 4</span>
        </div>
        <div class="account">
          <span>{user.displayName}</span>
          {notificationSettings?.email.enabled && (
            <button class="ghost" disabled={busy} onClick={() => void sendTestEmail()}>
              測試 Email
            </button>
          )}
          <button class="ghost" onClick={onLogout}>
            登出
          </button>
        </div>
      </header>
      <main class="workspace-grid">
        <section class="panel composer">
          <p class="kicker">NEW MONITOR</p>
          <h1>你想知道什麼？</h1>
          <form onSubmit={(event) => void interpret(event)}>
            <textarea
              rows={6}
              minLength={10}
              required
              value={request}
              onInput={(e) => setRequest(e.currentTarget.value)}
            />
            <div class="form-row">
              <label>
                模型來源
                <select value={provider} onChange={(e) => setProvider(e.currentTarget.value)}>
                  <option value="ollama">本機 Qwen / Ollama</option>
                  <option value="openai">OpenAI GPT</option>
                </select>
              </label>
              <button
                type="button"
                class="secondary"
                disabled={busy}
                onClick={() => void loadSingaporeConcertTemplate()}
              >
                使用新加坡演唱會範本
              </button>
              <button disabled={busy}>{busy ? "解析中…" : "產生預覽"}</button>
            </div>
          </form>
          {message && <p class="notice">{message}</p>}
        </section>

        {preview && (
          <section class="panel preview">
            <div class="section-heading">
              <div>
                <p class="kicker">REVIEW BEFORE SAVE</p>
                <h2>{preview.interpreted.summary}</h2>
              </div>
              <span class="confidence">{Math.round(preview.interpreted.confidence * 100)}%</span>
            </div>
            <p class="metadata">
              {preview.provider} · {preview.model} · {preview.promptVersion}
            </p>
            {preview.interpreted.clarificationQuestions.length > 0 && (
              <div class="callout">
                <strong>需要澄清</strong>
                <ul>
                  {preview.interpreted.clarificationQuestions.map((question) => (
                    <li>{question}</li>
                  ))}
                </ul>
                <button
                  class="ghost"
                  onClick={() => {
                    setRequest(
                      `${preview.originalRequest}\n\n請一併考慮以下補充：\n${preview.interpreted.clarificationQuestions
                        .map((question) => `- ${question}`)
                        .join("\n")}`
                    );
                    setPreview(undefined);
                  }}
                >
                  回到需求補充答案
                </button>
              </div>
            )}
            {preview.interpreted.warnings.length > 0 && (
              <div class="warnings">
                <strong>提醒</strong>
                <ul>
                  {preview.interpreted.warnings.map((warning) => (
                    <li>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            <label>
              可手動修改的 TaskDefinitionV1
              <textarea
                class="code-editor"
                rows={22}
                value={definitionText}
                onInput={(e) => setDefinitionText(e.currentTarget.value)}
                spellcheck={false}
              />
            </label>
            <div class="actions">
              <button class="secondary" onClick={() => setPreview(undefined)}>
                取消
              </button>
              <button disabled={busy} onClick={() => void save()}>
                確認並儲存草稿
              </button>
            </div>
          </section>
        )}

        <section class="inbox-section">
          <div class="section-heading">
            <div>
              <p class="kicker">PERSONAL INBOX</p>
              <h2>事件</h2>
            </div>
            <button class="ghost" onClick={() => void loadEvents()}>
              重新整理
            </button>
          </div>
          <div class="event-list">
            {events.length === 0 && <p class="empty">目前沒有符合條件的新事件。</p>}
            {events.map((event) => (
              <article class={`event-card event-card--${event.state}`} key={event.id}>
                <div class="event-main">
                  <div>
                    <div class="event-title">
                      <span class="event-type">{event.eventType}</span>
                      <h3>{event.title}</h3>
                    </div>
                    <p>{event.summary}</p>
                    <small>
                      {event.taskName} · score {Math.round(Number(event.score) * 100)}% ·{" "}
                      {event.provider}
                    </small>
                  </div>
                  <div class="event-actions">
                    <button class="secondary" onClick={() => void openEvent(event.id)}>
                      詳情
                    </button>
                    {event.canonicalUrl && (
                      <a href={event.canonicalUrl} target="_blank" rel="noreferrer">
                        原始來源
                      </a>
                    )}
                    <button class="ghost" onClick={() => void setEventState(event.id, "archived")}>
                      封存
                    </button>
                  </div>
                </div>
                <div class="feedback-actions">
                  {(["useful", "irrelevant", "duplicate"] as const).map((rating) => (
                    <button
                      class={event.feedbackRating === rating ? "selected" : "ghost"}
                      onClick={() => void sendFeedback(event.id, rating)}
                    >
                      {rating}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
          {selectedEvent && (
            <aside class="event-detail">
              <div class="section-heading">
                <div>
                  <p class="kicker">EVENT EVIDENCE</p>
                  <h3>{selectedEvent.title}</h3>
                </div>
                <button class="ghost" onClick={() => setSelectedEvent(undefined)}>
                  關閉
                </button>
              </div>
              <p>{selectedEvent.reason}</p>
              {selectedEvent.evidence.length > 0 && (
                <ul class="evidence-list">
                  {selectedEvent.evidence.map((entry) => (
                    <li>
                      <strong>{entry.sourceField}</strong>
                      <blockquote>{entry.quote}</blockquote>
                    </li>
                  ))}
                </ul>
              )}
              {selectedEvent.facts.length > 0 && (
                <dl class="facts">
                  {selectedEvent.facts.map((fact) => (
                    <div>
                      <dt>{fact.name}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {selectedEvent.uncertainties.length > 0 && (
                <p class="muted">不確定：{selectedEvent.uncertainties.join("；")}</p>
              )}
            </aside>
          )}
        </section>

        <section class="task-section">
          <div class="section-heading">
            <div>
              <p class="kicker">SAVED MONITORS</p>
              <h2>任務</h2>
            </div>
            <button class="ghost" onClick={() => void loadTasks()}>
              重新整理
            </button>
          </div>
          <div class="task-list">
            {tasks.length === 0 && (
              <p class="empty">還沒有任務。產生預覽並確認後，草稿才會出現在這裡。</p>
            )}
            {tasks.map((task) => (
              <article class="task-card" key={task.id}>
                <div class="task-card-main">
                  <div>
                    <div class="task-title">
                      <h3>{task.name}</h3>
                      <span class={`badge badge--${task.status}`}>{task.status}</span>
                    </div>
                    <p>{task.summary}</p>
                    <small>
                      rev {task.currentRevision} · {task.provider}/{task.model}
                    </small>
                    {task.clarificationQuestions.length > 0 && (
                      <p class="question-count">
                        尚有 {task.clarificationQuestions.length} 個問題待處理
                      </p>
                    )}
                  </div>
                  <div class="task-actions">
                    {task.status === "draft" || task.status === "paused" ? (
                      <button
                        class="secondary"
                        disabled={task.clarificationQuestions.length > 0}
                        onClick={() => void activate(task.id)}
                      >
                        啟用
                      </button>
                    ) : (
                      <>
                        <button class="secondary" onClick={() => void runNow(task.id)}>
                          立即執行
                        </button>
                        <button class="ghost" onClick={() => void pause(task.id)}>
                          暫停
                        </button>
                      </>
                    )}
                    <button class="ghost" onClick={() => void toggleRuns(task.id)}>
                      {openRuns === task.id ? "收起 Runs" : "查看 Runs"}
                    </button>
                  </div>
                </div>
                {openRuns === task.id && (
                  <div class="runs-panel">
                    <div class="runs-heading">
                      <strong>最近執行</strong>
                      <button class="ghost" onClick={() => void loadRuns(task.id)}>
                        重新整理
                      </button>
                    </div>
                    {(runs[task.id] ?? []).length === 0 && <p class="empty">尚無執行紀錄。</p>}
                    {(runs[task.id] ?? []).map((run) => (
                      <div class="run-row" key={run.id}>
                        <span class={`run-status run-status--${run.status}`}>{run.status}</span>
                        <span>{run.trigger}</span>
                        <span>rev {run.taskRevision ?? "legacy"}</span>
                        <span>
                          {run.newCount} new · {run.updatedCount} updated · {run.unchangedCount}{" "}
                          unchanged
                        </span>
                        <span>
                          analysis {run.analysisStatus} · {run.eventCount} events
                        </span>
                        <time>{new Date(run.createdAt).toLocaleString()}</time>
                        {run.errorCode && (
                          <span class="run-error" title={run.errorMessage ?? run.errorCode}>
                            {run.errorCode}
                          </span>
                        )}
                        {(run.status === "failed" || run.status === "dead_letter") && (
                          <button class="ghost" onClick={() => void retryRun(task.id, run.id)}>
                            重試
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function App() {
  const [loading, setLoading] = useState(true);
  const [bootstrap, setBootstrap] = useState(false);
  const [user, setUser] = useState<User>();

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const me = await api<{ user: User }>("/api/auth/me");
      setUser(me.user);
    } catch {
      setUser(undefined);
      const status = await api<{ required: boolean }>("/api/auth/bootstrap/status");
      setBootstrap(status.required);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function logout(): Promise<void> {
    await api("/api/auth/logout", { method: "POST" });
    await refresh();
  }

  if (loading)
    return (
      <main class="center">
        <p>正在載入 Chitanda…</p>
      </main>
    );
  if (!user)
    return (
      <main class="center">
        <AuthScreen bootstrap={bootstrap} onAuthenticated={() => void refresh()} />
      </main>
    );
  if (user.mfaRequired)
    return (
      <main class="center">
        <MfaSetup user={user} onComplete={() => void refresh()} />
      </main>
    );
  return <Workspace user={user} onLogout={() => void logout()} />;
}

const container = document.querySelector("#app");
if (!container) throw new Error("Missing #app container");
render(<App />, container);
