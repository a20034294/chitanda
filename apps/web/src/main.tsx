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
    "追蹤台北與新北未來六個月的演唱會，公布新場次時通知我，票價低於 3000 元優先。"
  );
  const [provider, setProvider] = useState("ollama");
  const [preview, setPreview] = useState<Preview>();
  const [definitionText, setDefinitionText] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function loadTasks(): Promise<void> {
    const result = await api<{ tasks: Task[] }>("/api/tasks");
    setTasks(result.tasks);
  }

  useEffect(() => {
    void loadTasks().catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "載入失敗")
    );
  }, []);

  async function interpret(event: Event): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await api<Preview>("/api/tasks/interpret", {
        method: "POST",
        body: JSON.stringify({ request, provider, locale: "zh-TW", timezone: "Asia/Taipei" })
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

  return (
    <div class="workspace">
      <header class="topbar">
        <div>
          <span class="brand">Chitanda</span>
          <span class="phase">Phase 1</span>
        </div>
        <div class="account">
          <span>{user.displayName}</span>
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
                {task.status === "draft" && (
                  <button
                    class="secondary"
                    disabled={task.clarificationQuestions.length > 0}
                    onClick={() => void activate(task.id)}
                  >
                    啟用
                  </button>
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
