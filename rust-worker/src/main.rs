use anyhow::{anyhow, Context, Result};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use nanoid::nanoid;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, Semaphore};
use url::Url;

const HOST: &str = "127.0.0.1";
const MANUAL_STOP: &str = "批量任务已手动停止";

#[derive(Clone)]
struct AppState {
    tasks: Arc<Mutex<HashMap<String, Arc<TaskRuntime>>>>,
    persistence_lock: Arc<Mutex<()>>,
    plugin_dir: PathBuf,
    http: reqwest::Client,
}

struct TaskRuntime {
    progress: Mutex<CompanionTaskProgress>,
    cancel_requested: Mutex<bool>,
    ai_lock: Semaphore,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanionProxyRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanionProxyResponse {
    status: u16,
    status_text: String,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistenceConfig {
    base_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanionBatchResource {
    resource_id: String,
    label: String,
    #[serde(default)]
    source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanionTranslationConfig {
    chat_completions_url: String,
    api_key: String,
    model: String,
    timeout_ms: u64,
    response_format: String,
    batch_size: usize,
    concurrency: usize,
    prompts: PromptConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PromptConfig {
    ast: String,
    regex: String,
    theme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginBatchTranslatePayload {
    persistence: PersistenceConfig,
    resources: Vec<CompanionBatchResource>,
    config: CompanionTranslationConfig,
    checkpoint_key: String,
    concurrency: usize,
    #[serde(default)]
    completed_resources: Option<usize>,
    #[serde(default)]
    processed_items: Option<usize>,
    #[serde(default)]
    total_items: Option<usize>,
}

type ThemeBatchTranslatePayload = PluginBatchTranslatePayload;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FailureRetryPayload {
    persistence: PersistenceConfig,
    failures: Vec<BatchTaskFailureRecord>,
    config: CompanionTranslationConfig,
    concurrency: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractBatchPayload {
    persistence: PersistenceConfig,
    resources: Vec<Value>,
    concurrency: usize,
    checkpoint_key: String,
    #[serde(default)]
    completed_resources: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanionTaskProgress {
    task_id: String,
    scope: String,
    mode: String,
    status: String,
    current_label: String,
    processed_resources: usize,
    total_resources: usize,
    processed_items: usize,
    total_items: usize,
    success_count: usize,
    failed_count: usize,
    skipped_count: usize,
    source_revision: usize,
    record_revision: usize,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchTaskCheckpointResource {
    resource_id: String,
    label: String,
    source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchTaskCheckpoint {
    scope: String,
    mode: String,
    resources: Vec<BatchTaskCheckpointResource>,
    total_resources: usize,
    completed_resources: usize,
    total_items: usize,
    processed_items: usize,
    stopped_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchTaskFailureRecord {
    id: String,
    scope: String,
    resource_id: String,
    resource_label: String,
    source_id: String,
    batch_type: String,
    error_message: String,
    items: Vec<BatchTaskFailureItem>,
    failed_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchTaskFailureItem {
    source: String,
    target: String,
    dict_index: isize,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanionBatchFailure {
    resource_id: String,
    resource_label: String,
    source_id: String,
    batch_type: String,
    error_message: String,
    items: Vec<BatchTaskFailureItem>,
}

#[derive(Debug, Clone)]
struct PersistencePaths {
    sources_dir: PathBuf,
    meta_path: PathBuf,
    batch_task_record_path: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    let port = env::args()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(18743);
    let plugin_dir = env::current_dir().context("failed to read current directory")?;
    let state = AppState {
        tasks: Arc::new(Mutex::new(HashMap::new())),
        persistence_lock: Arc::new(Mutex::new(())),
        plugin_dir,
        http: reqwest::Client::builder()
            .danger_accept_invalid_certs(false)
            .build()?,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/proxy", post(proxy_route))
        .route("/task", post(task_route))
        .route("/task/start", post(task_start_route))
        .route("/task/status", get(task_status_route))
        .route("/task/cancel", post(task_cancel_route))
        .with_state(state);

    let addr: SocketAddr = format!("{HOST}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("ready {HOST}:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

async fn proxy_route(
    State(state): State<AppState>,
    Json(payload): Json<CompanionProxyRequest>,
) -> impl IntoResponse {
    match proxy(&state, payload).await {
        Ok(response) => Json(json!({ "ok": true, "response": response })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn task_route(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let task_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let task_payload = payload.get("payload").cloned().unwrap_or(Value::Null);
    match handle_sync_task(&state, task_type, task_payload).await {
        Ok(result) => Json(json!({ "ok": true, "result": result })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn task_start_route(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let task_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let task_payload = payload.get("payload").cloned().unwrap_or(Value::Null);
    match start_async_task(state.clone(), task_type, task_payload).await {
        Ok(task) => {
            let progress = task.progress.lock().await.clone();
            Json(json!({ "ok": true, "taskId": progress.task_id, "progress": progress }))
                .into_response()
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct StatusQuery {
    id: String,
}

async fn task_status_route(
    State(state): State<AppState>,
    Query(query): Query<StatusQuery>,
) -> impl IntoResponse {
    match get_task(&state, &query.id).await {
        Some(task) => Json(json!({ "ok": true, "progress": task.progress.lock().await.clone() }))
            .into_response(),
        None => error_response(StatusCode::INTERNAL_SERVER_ERROR, "任务不存在"),
    }
}

async fn task_cancel_route(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let task_id = payload
        .get("taskId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match get_task(&state, task_id).await {
        Some(task) => {
            *task.cancel_requested.lock().await = true;
            touch_progress(&task, json!({ "currentLabel": "" })).await;
            Json(json!({ "ok": true, "progress": task.progress.lock().await.clone() }))
                .into_response()
        }
        None => error_response(StatusCode::INTERNAL_SERVER_ERROR, "任务不存在"),
    }
}

fn error_response(status: StatusCode, message: impl Into<String>) -> axum::response::Response {
    (
        status,
        Json(json!({ "ok": false, "error": message.into() })),
    )
        .into_response()
}

async fn get_task(state: &AppState, task_id: &str) -> Option<Arc<TaskRuntime>> {
    state.tasks.lock().await.get(task_id).cloned()
}

async fn start_async_task(
    state: AppState,
    task_type: String,
    payload: Value,
) -> Result<Arc<TaskRuntime>> {
    let task_id = nanoid!(16);
    let progress = create_initial_progress(&task_type, &payload, task_id.clone());
    let task = Arc::new(TaskRuntime {
        progress: Mutex::new(progress),
        cancel_requested: Mutex::new(false),
        ai_lock: Semaphore::new(1),
    });
    state.tasks.lock().await.insert(task_id, task.clone());
    let task_ref = task.clone();
    tokio::spawn(async move {
        run_async_task(state, task_ref, task_type, payload).await;
    });
    Ok(task)
}

fn create_initial_progress(
    task_type: &str,
    payload: &Value,
    task_id: String,
) -> CompanionTaskProgress {
    let is_theme = task_type.starts_with("theme");
    let is_extract = task_type.ends_with("extract");
    let is_retry = task_type.ends_with("retry");
    let resources = if is_retry {
        payload
            .get("failures")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    } else {
        payload
            .get("resources")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let total_items = if is_retry {
        resources
            .iter()
            .map(|failure| {
                failure
                    .get("items")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0)
            })
            .sum()
    } else {
        payload
            .get("totalItems")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize
    };

    CompanionTaskProgress {
        task_id,
        scope: if is_theme { "theme" } else { "plugin" }.to_string(),
        mode: if is_extract { "extract" } else { "translate" }.to_string(),
        status: "queued".to_string(),
        current_label: String::new(),
        processed_resources: payload
            .get("completedResources")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        total_resources: resources.len(),
        processed_items: payload
            .get("processedItems")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        total_items,
        success_count: 0,
        failed_count: 0,
        skipped_count: 0,
        source_revision: 0,
        record_revision: 0,
        updated_at: now_ms(),
        error: None,
    }
}

async fn run_async_task(
    state: AppState,
    task: Arc<TaskRuntime>,
    task_type: String,
    payload: Value,
) {
    touch_progress(&task, json!({ "status": "running" })).await;
    let result = match task_type.as_str() {
        "plugin-batch-extract" => {
            handle_extract_batch(&state, task.clone(), payload, "plugin", "extract").await
        }
        "theme-batch-extract" => {
            handle_extract_batch(&state, task.clone(), payload, "theme", "extract").await
        }
        "plugin-batch-translate" => {
            handle_plugin_batch_translate(&state, task.clone(), payload).await
        }
        "theme-batch-translate" => {
            handle_theme_batch_translate(&state, task.clone(), payload).await
        }
        "plugin-failure-retry" => handle_plugin_failure_retry(&state, task.clone(), payload).await,
        "theme-failure-retry" => handle_theme_failure_retry(&state, task.clone(), payload).await,
        _ => Err(anyhow!("未知任务类型: {task_type}")),
    };

    match result {
        Ok(()) => {
            let cancelled = *task.cancel_requested.lock().await;
            touch_progress(&task, json!({ "status": if cancelled { "cancelled" } else { "completed" }, "currentLabel": "" })).await;
        }
        Err(error) => {
            let message = error.to_string();
            touch_progress(
                &task,
                json!({
                    "status": if message.contains(MANUAL_STOP) { "cancelled" } else { "failed" },
                    "currentLabel": "",
                    "error": message,
                }),
            )
            .await;
        }
    }
}

async fn is_task_active(task: &TaskRuntime) -> bool {
    let cancelled = *task.cancel_requested.lock().await;
    let status = task.progress.lock().await.status.clone();
    !cancelled && status != "cancelled" && status != "failed"
}

async fn ensure_not_cancelled(task: &TaskRuntime) -> Result<()> {
    if *task.cancel_requested.lock().await {
        Err(anyhow!(MANUAL_STOP))
    } else {
        Ok(())
    }
}

async fn touch_progress(task: &TaskRuntime, updates: Value) {
    let mut progress = task.progress.lock().await;
    if let Some(map) = updates.as_object() {
        for (key, value) in map {
            match key.as_str() {
                "status" => progress.status = value.as_str().unwrap_or_default().to_string(),
                "currentLabel" => {
                    progress.current_label = value.as_str().unwrap_or_default().to_string()
                }
                "processedResources" => {
                    progress.processed_resources = value
                        .as_u64()
                        .unwrap_or(progress.processed_resources as u64)
                        as usize
                }
                "processedItems" => {
                    progress.processed_items =
                        value.as_u64().unwrap_or(progress.processed_items as u64) as usize
                }
                "successCount" => {
                    progress.success_count =
                        value.as_u64().unwrap_or(progress.success_count as u64) as usize
                }
                "failedCount" => {
                    progress.failed_count =
                        value.as_u64().unwrap_or(progress.failed_count as u64) as usize
                }
                "skippedCount" => {
                    progress.skipped_count =
                        value.as_u64().unwrap_or(progress.skipped_count as u64) as usize
                }
                "sourceRevision" => {
                    progress.source_revision =
                        value.as_u64().unwrap_or(progress.source_revision as u64) as usize
                }
                "recordRevision" => {
                    progress.record_revision =
                        value.as_u64().unwrap_or(progress.record_revision as u64) as usize
                }
                "error" => progress.error = value.as_str().map(str::to_string),
                _ => {}
            }
        }
    }
    progress.updated_at = now_ms();
}

async fn bump_source_revision(task: &TaskRuntime) {
    let next = task.progress.lock().await.source_revision + 1;
    touch_progress(task, json!({ "sourceRevision": next })).await;
}

async fn bump_record_revision(task: &TaskRuntime) {
    let next = task.progress.lock().await.record_revision + 1;
    touch_progress(task, json!({ "recordRevision": next })).await;
}

async fn proxy(state: &AppState, payload: CompanionProxyRequest) -> Result<CompanionProxyResponse> {
    let target = Url::parse(&payload.url)?;
    if target.scheme() != "http" && target.scheme() != "https" {
        return Err(anyhow!("只允许 HTTP/HTTPS 请求"));
    }

    let timeout = Duration::from_millis(payload.timeout_ms.unwrap_or(60_000).max(1000));
    let method = payload.method.parse()?;
    let mut request = state.http.request(method, target).timeout(timeout);
    for (key, value) in sanitize_headers(&payload.headers) {
        request = request.header(key, value);
    }
    if let Some(body) = payload.body {
        request = request.body(body);
    }

    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            anyhow!("请求超时")
        } else {
            anyhow!(error)
        }
    })?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or_default().to_string();
    let headers = response_headers(response.headers());
    let body = response.text().await?;
    Ok(CompanionProxyResponse {
        status: status.as_u16(),
        status_text,
        headers,
        body,
    })
}

fn sanitize_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for (key, value) in headers {
        let lower = key.to_lowercase();
        if [
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "accept-encoding",
        ]
        .contains(&lower.as_str())
        {
            continue;
        }
        result.insert(key.clone(), value.clone());
    }
    result.insert("accept-encoding".to_string(), "identity".to_string());
    result
}

fn response_headers(headers: &HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter_map(|(key, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (key.as_str().to_string(), value.to_string()))
        })
        .collect()
}

async fn handle_sync_task(state: &AppState, task_type: &str, payload: Value) -> Result<Value> {
    match task_type {
        "plugin-extract" | "theme-extract" => call_legacy_worker(state, task_type, payload).await,
        "plugin-translate" => {
            let result = handle_plugin_translate(payload, None).await?;
            Ok(serde_json::to_value(result)?)
        }
        "theme-translate" => {
            let result = handle_theme_translate(payload, None).await?;
            Ok(serde_json::to_value(result)?)
        }
        "plugin-retry" => {
            let result = handle_plugin_retry(payload, None).await?;
            Ok(serde_json::to_value(result)?)
        }
        "theme-retry" => {
            let result = handle_theme_retry(payload, None).await?;
            Ok(serde_json::to_value(result)?)
        }
        _ => Err(anyhow!("未知任务类型: {task_type}")),
    }
}

async fn call_legacy_worker(state: &AppState, task_type: &str, payload: Value) -> Result<Value> {
    let script_path = state.plugin_dir.join("i18n-companion-worker.cjs");
    if !script_path.exists() {
        return Err(anyhow!("旧版提取 worker 不存在: {}", script_path.display()));
    }
    let request = json!({ "type": task_type, "payload": payload });
    let node_path = env::var("I18N_COMPANION_NODE_PATH").unwrap_or_else(|_| "node".to_string());
    let mut child = Command::new(node_path)
        .arg(&script_path)
        .arg("stdio-task")
        .current_dir(&state.plugin_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| "无法启动旧版提取 worker")?;

    child
        .stdin
        .as_mut()
        .context("legacy worker stdin unavailable")?
        .write_all(request.to_string().as_bytes())?;
    drop(child.stdin.take());

    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(anyhow!(String::from_utf8_lossy(&output.stderr).to_string()));
    }
    let value: Value =
        serde_json::from_slice(&output.stdout).context("旧版提取 worker 返回非 JSON")?;
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        let error = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("旧版提取 worker 返回异常")
            .to_string();
        return Err(anyhow!(error));
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

fn paths(base_path: &str) -> PersistencePaths {
    let base_path = PathBuf::from(base_path);
    PersistencePaths {
        sources_dir: base_path.join("translations"),
        meta_path: base_path.join("metadata.json"),
        batch_task_record_path: base_path.join("batch-task-records.json"),
    }
}

fn load_json_or(path: &Path, fallback: Value) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(fallback)
}

fn write_json_pretty(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(value)?)?;
    Ok(())
}

fn load_meta(paths: &PersistencePaths) -> Value {
    let raw = load_json_or(
        &paths.meta_path,
        json!({ "schemaVersion": 2, "sources": {} }),
    );
    if raw.get("sources").is_some() {
        raw
    } else {
        json!({ "schemaVersion": 2, "sources": {} })
    }
}

fn load_record(paths: &PersistencePaths) -> Value {
    let raw = load_json_or(
        &paths.batch_task_record_path,
        json!({ "schemaVersion": 1, "checkpoints": {}, "failures": [], "updatedAt": 0 }),
    );
    json!({
        "schemaVersion": raw.get("schemaVersion").and_then(Value::as_u64).unwrap_or(1),
        "checkpoints": raw.get("checkpoints").cloned().unwrap_or_else(|| json!({})),
        "failures": raw.get("failures").and_then(Value::as_array).cloned().unwrap_or_default(),
        "updatedAt": raw.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
    })
}

fn save_record(paths: &PersistencePaths, mut record: Value) -> Result<()> {
    record["updatedAt"] = json!(now_ms());
    write_json_pretty(&paths.batch_task_record_path, &record)
}

fn read_translation(paths: &PersistencePaths, source_id: &str) -> Option<Value> {
    let file_path = paths.sources_dir.join(format!("{source_id}.json"));
    fs::read_to_string(file_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn save_translation(paths: &PersistencePaths, source_id: &str, content: &Value) -> Result<()> {
    fs::create_dir_all(&paths.sources_dir)?;
    fs::write(
        paths.sources_dir.join(format!("{source_id}.json")),
        serde_json::to_string_pretty(content)?,
    )?;
    Ok(())
}

async fn save_translated_source(
    state: &AppState,
    paths: &PersistencePaths,
    source_id: &str,
    content: &Value,
) -> Result<()> {
    let _guard = state.persistence_lock.lock().await;
    let mut meta = load_meta(paths);
    save_translation(paths, source_id, content)?;
    if let Some(source) = meta.pointer_mut(&format!("/sources/{source_id}")) {
        source["title"] = content
            .pointer("/metadata/title")
            .cloned()
            .unwrap_or_else(|| {
                source
                    .get("title")
                    .cloned()
                    .unwrap_or(Value::String(String::new()))
            });
        source["origin"] = json!("local");
        if let Some(obj) = source.as_object_mut() {
            obj.remove("cloud");
            obj.insert(
                "checksum".to_string(),
                Value::String(calculate_checksum(content)?),
            );
            obj.insert("updatedAt".to_string(), json!(now_ms()));
        }
        write_json_pretty(&paths.meta_path, &meta)?;
    }
    Ok(())
}

async fn save_extracted_source(
    state: &AppState,
    paths: &PersistencePaths,
    plugin_id: &str,
    content: &Value,
    title: &str,
    source_type: &str,
) -> Result<()> {
    let _guard = state.persistence_lock.lock().await;
    let mut meta = load_meta(paths);
    let source_id = nanoid!(32);
    if let Some(sources) = meta.get_mut("sources").and_then(Value::as_object_mut) {
        for source in sources.values_mut() {
            if source.get("plugin").and_then(Value::as_str) == Some(plugin_id) {
                source["isActive"] = json!(false);
            }
        }
        sources.insert(
            source_id.clone(),
            json!({
                "id": source_id,
                "plugin": plugin_id,
                "title": title,
                "type": source_type,
                "origin": "local",
                "isActive": true,
                "checksum": calculate_checksum(content)?,
                "createdAt": now_ms(),
                "updatedAt": now_ms(),
            }),
        );
    }
    save_translation(paths, &source_id, content)?;
    write_json_pretty(&paths.meta_path, &meta)?;
    Ok(())
}

async fn update_record<F>(state: &AppState, paths: &PersistencePaths, updater: F) -> Result<()>
where
    F: FnOnce(&mut Value),
{
    let _guard = state.persistence_lock.lock().await;
    let mut record = load_record(paths);
    updater(&mut record);
    save_record(paths, record)
}

async fn save_checkpoint(
    state: &AppState,
    paths: &PersistencePaths,
    key: &str,
    checkpoint: BatchTaskCheckpoint,
) -> Result<()> {
    update_record(state, paths, |record| {
        record["checkpoints"][key] = serde_json::to_value(checkpoint).unwrap_or(Value::Null);
    })
    .await
}

async fn clear_checkpoint(state: &AppState, paths: &PersistencePaths, key: &str) -> Result<()> {
    update_record(state, paths, |record| {
        if let Some(checkpoints) = record.get_mut("checkpoints").and_then(Value::as_object_mut) {
            checkpoints.remove(key);
        }
    })
    .await
}

async fn replace_failures_for_source(
    state: &AppState,
    paths: &PersistencePaths,
    scope: &str,
    source_id: &str,
    failures: Vec<CompanionBatchFailure>,
) -> Result<()> {
    update_record(state, paths, |record| {
        let mut existing = record
            .get("failures")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        existing.retain(|item| {
            !(item.get("scope").and_then(Value::as_str) == Some(scope)
                && item.get("sourceId").and_then(Value::as_str) == Some(source_id))
        });
        for failure in failures.into_iter().rev() {
            existing.insert(
                0,
                serde_json::to_value(build_failure_record(scope, failure)).unwrap_or(Value::Null),
            );
        }
        existing.truncate(500);
        record["failures"] = Value::Array(existing);
    })
    .await
}

async fn remove_failures(state: &AppState, paths: &PersistencePaths, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let ids: HashSet<&str> = ids.iter().map(String::as_str).collect();
    update_record(state, paths, |record| {
        let mut existing = record
            .get("failures")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        existing.retain(|item| {
            !ids.contains(item.get("id").and_then(Value::as_str).unwrap_or_default())
        });
        record["failures"] = Value::Array(existing);
    })
    .await
}

fn build_failure_record(scope: &str, failure: CompanionBatchFailure) -> BatchTaskFailureRecord {
    BatchTaskFailureRecord {
        id: format!(
            "{}:{}:{}:{}",
            failure.source_id,
            failure.batch_type,
            now_ms(),
            nanoid!(6)
        ),
        scope: scope.to_string(),
        resource_id: failure.resource_id,
        resource_label: failure.resource_label,
        source_id: failure.source_id,
        batch_type: failure.batch_type,
        error_message: failure.error_message,
        items: failure.items,
        failed_at: now_ms(),
    }
}

async fn handle_extract_batch(
    state: &AppState,
    task: Arc<TaskRuntime>,
    payload: Value,
    scope: &str,
    mode: &str,
) -> Result<()> {
    let batch: ExtractBatchPayload = serde_json::from_value(payload.clone())?;
    let paths = paths(&batch.persistence.base_path);
    let completed = Arc::new(Mutex::new(HashSet::<usize>::new()));
    let semaphore = Arc::new(Semaphore::new(batch.concurrency.max(1)));
    let resources = Arc::new(batch.resources.clone());
    let mut handles = Vec::new();

    for (index, resource) in batch.resources.into_iter().enumerate() {
        let permit = semaphore.clone().acquire_owned().await?;
        let state = state.clone();
        let task = task.clone();
        let paths = paths.clone();
        let completed = completed.clone();
        let resources = resources.clone();
        let checkpoint_key = batch.checkpoint_key.clone();
        let scope = scope.to_string();
        let mode = mode.to_string();
        handles.push(tokio::spawn(async move {
            let _permit = permit;
            if !is_task_active(&task).await {
                return Ok::<(), anyhow::Error>(());
            }
            let label = resource
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            touch_progress(&task, json!({ "currentLabel": label })).await;
            let task_type = if scope == "plugin" {
                "plugin-extract"
            } else {
                "theme-extract"
            };
            match call_legacy_worker(&state, task_type, resource).await {
                Ok(result) if result.get("status").and_then(Value::as_str) == Some("success") => {
                    let plugin_id = result
                        .get("pluginId")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let title = result
                        .pointer("/options/title")
                        .and_then(Value::as_str)
                        .unwrap_or(plugin_id);
                    let source_type = result
                        .pointer("/options/type")
                        .and_then(Value::as_str)
                        .unwrap_or("plugin");
                    let content = result.get("content").cloned().unwrap_or(Value::Null);
                    save_extracted_source(&state, &paths, plugin_id, &content, title, source_type)
                        .await?;
                    bump_source_revision(&task).await;
                    increment_progress(&task, "successCount", 1).await;
                }
                Ok(result) if result.get("status").and_then(Value::as_str) == Some("skipped") => {
                    increment_progress(&task, "skippedCount", 1).await;
                }
                Ok(result) => {
                    eprintln!(
                        "[i18n] Failed to batch extract: {}",
                        result
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                    );
                    increment_progress(&task, "failedCount", 1).await;
                }
                Err(error) => {
                    eprintln!("[i18n] Failed to batch extract: {error}");
                    increment_progress(&task, "failedCount", 1).await;
                }
            }
            completed.lock().await.insert(index);
            increment_progress(&task, "processedResources", 1).await;
            let progress = task.progress.lock().await.clone();
            let completed_set = completed.lock().await.clone();
            save_checkpoint(
                &state,
                &paths,
                &checkpoint_key,
                create_checkpoint(&scope, &mode, &resources, &completed_set, &progress),
            )
            .await?;
            bump_record_revision(&task).await;
            Ok(())
        }));
    }

    for handle in handles {
        handle.await??;
    }
    if *task.cancel_requested.lock().await {
        return Ok(());
    }
    clear_checkpoint(state, &paths, &batch.checkpoint_key).await?;
    bump_record_revision(&task).await;
    Ok(())
}

async fn increment_progress(task: &TaskRuntime, field: &str, amount: usize) {
    let mut progress = task.progress.lock().await;
    match field {
        "processedResources" => progress.processed_resources += amount,
        "processedItems" => progress.processed_items += amount,
        "successCount" => progress.success_count += amount,
        "failedCount" => progress.failed_count += amount,
        "skippedCount" => progress.skipped_count += amount,
        _ => {}
    }
    progress.updated_at = now_ms();
}

fn create_checkpoint(
    scope: &str,
    mode: &str,
    resources: &[Value],
    completed: &HashSet<usize>,
    progress: &CompanionTaskProgress,
) -> BatchTaskCheckpoint {
    BatchTaskCheckpoint {
        scope: scope.to_string(),
        mode: mode.to_string(),
        resources: resources
            .iter()
            .enumerate()
            .filter(|(index, _)| !completed.contains(index))
            .map(|(_, resource)| BatchTaskCheckpointResource {
                resource_id: resource
                    .get("resourceId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                label: resource
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                source_id: resource
                    .get("sourceId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
            .collect(),
        total_resources: progress.total_resources,
        completed_resources: progress.processed_resources,
        total_items: progress.total_items,
        processed_items: progress.processed_items,
        stopped_at: now_ms(),
    }
}

async fn handle_plugin_batch_translate(
    state: &AppState,
    task: Arc<TaskRuntime>,
    payload: Value,
) -> Result<()> {
    let batch: PluginBatchTranslatePayload = serde_json::from_value(payload)?;
    handle_batch_translate(state, task, batch, true).await
}

async fn handle_theme_batch_translate(
    state: &AppState,
    task: Arc<TaskRuntime>,
    payload: Value,
) -> Result<()> {
    let batch: ThemeBatchTranslatePayload = serde_json::from_value(payload)?;
    handle_batch_translate(state, task, batch, false).await
}

async fn handle_batch_translate(
    state: &AppState,
    task: Arc<TaskRuntime>,
    batch: PluginBatchTranslatePayload,
    is_plugin: bool,
) -> Result<()> {
    let paths = paths(&batch.persistence.base_path);
    let scope = if is_plugin { "plugin" } else { "theme" };
    let resources_value: Vec<Value> = batch
        .resources
        .iter()
        .map(|resource| serde_json::to_value(resource).unwrap_or(Value::Null))
        .collect();
    let mut completed = HashSet::<usize>::new();
    let mut resource_states = Vec::<BatchResourceState>::new();
    let mut ast_items = Vec::<Value>::new();
    let mut regex_items = Vec::<Value>::new();
    let mut theme_items = Vec::<Value>::new();
    let mut ast_id = 0u64;
    let mut regex_id = 0u64;
    let mut theme_id = 0u64;

    for (index, resource) in batch.resources.iter().cloned().enumerate() {
        ensure_not_cancelled(&task).await?;
        touch_progress(&task, json!({ "currentLabel": resource.label })).await;

        let Some(source_id) = resource.source_id.clone() else {
            mark_batch_translate_resource_completed(
                state,
                &task,
                &paths,
                &batch.checkpoint_key,
                scope,
                &resources_value,
                &mut completed,
                index,
                true,
            )
            .await?;
            continue;
        };
        let Some(translation_json) = read_translation(&paths, &source_id) else {
            mark_batch_translate_resource_completed(
                state,
                &task,
                &paths,
                &batch.checkpoint_key,
                scope,
                &resources_value,
                &mut completed,
                index,
                true,
            )
            .await?;
            continue;
        };
        let pending = if is_plugin {
            count_pending_plugin_items(&translation_json)
        } else {
            count_pending_theme_items(&translation_json)
        };
        if pending == 0 {
            mark_batch_translate_resource_completed(
                state,
                &task,
                &paths,
                &batch.checkpoint_key,
                scope,
                &resources_value,
                &mut completed,
                index,
                true,
            )
            .await?;
            continue;
        }

        let state_index = resource_states.len();
        let resource_state = BatchResourceState {
            original_index: index,
            resource,
            source_id,
            translation_json,
            processed_items: 0,
            failures: Vec::new(),
        };
        if is_plugin {
            collect_plugin_packed_items(
                state_index,
                &resource_state,
                &mut ast_id,
                &mut regex_id,
                &mut ast_items,
                &mut regex_items,
            );
        } else {
            collect_theme_packed_items(
                state_index,
                &resource_state,
                &mut theme_id,
                &mut theme_items,
            );
        }
        resource_states.push(resource_state);
    }

    if is_plugin {
        let ast_report = translate_packed_batches(
            &ast_items,
            &batch.config.prompts.ast,
            &batch.config,
            |item| json!({ "i": item["id"], "s": item["source"], "y": item["type"], "n": item["name"] }),
            Some(task.clone()),
        )
        .await?;
        apply_packed_translation_report(&mut resource_states, ast_report, "ast", true);

        let regex_report = translate_packed_batches(
            &regex_items,
            &batch.config.prompts.regex,
            &batch.config,
            |item| json!({ "i": item["id"], "s": item["source"] }),
            Some(task.clone()),
        )
        .await?;
        apply_packed_translation_report(&mut resource_states, regex_report, "regex", true);
    } else {
        let theme_report = translate_packed_batches(
            &theme_items,
            &batch.config.prompts.theme,
            &batch.config,
            |item| json!({ "i": item["id"], "s": item["source"], "y": item["type"] }),
            Some(task.clone()),
        )
        .await?;
        apply_packed_translation_report(&mut resource_states, theme_report, "theme", false);
    }

    for resource_state in resource_states {
        ensure_not_cancelled(&task).await?;
        touch_progress(
            &task,
            json!({ "currentLabel": resource_state.resource.label }),
        )
        .await;
        save_translated_source(
            state,
            &paths,
            &resource_state.source_id,
            &resource_state.translation_json,
        )
        .await?;
        replace_failures_for_source(
            state,
            &paths,
            scope,
            &resource_state.source_id,
            resource_state.failures,
        )
        .await?;
        increment_progress(&task, "processedItems", resource_state.processed_items).await;
        increment_progress(&task, "successCount", 1).await;
        bump_source_revision(&task).await;
        mark_batch_translate_resource_completed(
            state,
            &task,
            &paths,
            &batch.checkpoint_key,
            scope,
            &resources_value,
            &mut completed,
            resource_state.original_index,
            false,
        )
        .await?;
    }

    if *task.cancel_requested.lock().await {
        return Ok(());
    }
    clear_checkpoint(state, &paths, &batch.checkpoint_key).await?;
    bump_record_revision(&task).await;
    Ok(())
}

#[derive(Debug, Clone)]
struct BatchResourceState {
    original_index: usize,
    resource: CompanionBatchResource,
    source_id: String,
    translation_json: Value,
    processed_items: usize,
    failures: Vec<CompanionBatchFailure>,
}

#[derive(Debug, Clone)]
struct PackedBatchReport {
    translated_items: Vec<Value>,
    failures: Vec<PackedBatchFailure>,
}

#[derive(Debug, Clone)]
struct PackedBatchFailure {
    resource_state_index: usize,
    error_message: String,
    items: Vec<BatchTaskFailureItem>,
}

async fn mark_batch_translate_resource_completed(
    state: &AppState,
    task: &TaskRuntime,
    paths: &PersistencePaths,
    checkpoint_key: &str,
    scope: &str,
    resources: &[Value],
    completed: &mut HashSet<usize>,
    index: usize,
    skipped: bool,
) -> Result<()> {
    if skipped {
        increment_progress(task, "skippedCount", 1).await;
    }
    completed.insert(index);
    increment_progress(task, "processedResources", 1).await;
    let progress = task.progress.lock().await.clone();
    save_checkpoint(
        state,
        paths,
        checkpoint_key,
        create_checkpoint(scope, "translate", resources, completed, &progress),
    )
    .await?;
    bump_record_revision(task).await;
    Ok(())
}

fn collect_plugin_packed_items(
    resource_state_index: usize,
    resource_state: &BatchResourceState,
    ast_id: &mut u64,
    regex_id: &mut u64,
    ast_items: &mut Vec<Value>,
    regex_items: &mut Vec<Value>,
) {
    if let Some(dict) = resource_state
        .translation_json
        .get("dict")
        .and_then(Value::as_object)
    {
        for (file, file_dict) in dict {
            if let Some(ast) = file_dict.get("ast").and_then(Value::as_array) {
                for (index, item) in ast.iter().enumerate() {
                    if should_translate(item.get("target"), item.get("source")) {
                        ast_items.push(json!({
                            "id": *ast_id,
                            "resourceStateIndex": resource_state_index,
                            "file": file,
                            "dictIndex": index,
                            "type": item.get("type").and_then(Value::as_str).unwrap_or(""),
                            "name": item.get("name").and_then(Value::as_str).unwrap_or(""),
                            "source": item.get("source").and_then(Value::as_str).unwrap_or(""),
                            "target": item.get("target").and_then(Value::as_str).unwrap_or(""),
                        }));
                        *ast_id += 1;
                    }
                }
            }
            if let Some(regex) = file_dict.get("regex").and_then(Value::as_array) {
                for (index, item) in regex.iter().enumerate() {
                    if should_translate(item.get("target"), item.get("source")) {
                        regex_items.push(json!({
                            "id": *regex_id,
                            "resourceStateIndex": resource_state_index,
                            "file": file,
                            "dictIndex": index,
                            "source": item.get("source").and_then(Value::as_str).unwrap_or(""),
                            "target": item.get("target").and_then(Value::as_str).unwrap_or(""),
                        }));
                        *regex_id += 1;
                    }
                }
            }
        }
    }
}

fn collect_theme_packed_items(
    resource_state_index: usize,
    resource_state: &BatchResourceState,
    theme_id: &mut u64,
    theme_items: &mut Vec<Value>,
) {
    if let Some(dict) = resource_state
        .translation_json
        .get("dict")
        .and_then(Value::as_array)
    {
        for (index, item) in dict.iter().enumerate() {
            if should_translate(item.get("target"), item.get("source")) {
                theme_items.push(json!({
                    "id": *theme_id,
                    "resourceStateIndex": resource_state_index,
                    "dictIndex": index,
                    "type": item.get("type").and_then(Value::as_str).unwrap_or(""),
                    "source": item.get("source").and_then(Value::as_str).unwrap_or(""),
                    "target": item.get("target").and_then(Value::as_str).unwrap_or(""),
                }));
                *theme_id += 1;
            }
        }
    }
}

async fn translate_packed_batches<F>(
    items: &[Value],
    prompt: &str,
    config: &CompanionTranslationConfig,
    simplify: F,
    task: Option<Arc<TaskRuntime>>,
) -> Result<PackedBatchReport>
where
    F: Fn(&Value) -> Value,
{
    let mut report = PackedBatchReport {
        translated_items: Vec::new(),
        failures: Vec::new(),
    };
    if items.is_empty() {
        return Ok(report);
    }

    for batch in items.chunks(config.batch_size.max(1)) {
        if let Some(task) = &task {
            ensure_not_cancelled(task).await?;
        }
        let simplified: Vec<Value> = batch.iter().map(&simplify).collect();
        let result = if let Some(task) = &task {
            let _permit = task.ai_lock.acquire().await?;
            ensure_not_cancelled(task).await?;
            let result = call_chat_completion(&simplified, prompt, config).await;
            ensure_not_cancelled(task).await?;
            result
        } else {
            call_chat_completion(&simplified, prompt, config).await
        };

        match result {
            Ok(translated) => {
                for item in batch {
                    let id = item.get("id").and_then(Value::as_u64).unwrap_or(0);
                    let mut mapped = item.clone();
                    let target = translated
                        .iter()
                        .find(|entry| entry.i == id)
                        .map(|entry| entry.t.clone())
                        .filter(|value| !value.trim().is_empty() && value.trim() != "空")
                        .unwrap_or_else(|| fallback_target(item));
                    mapped["target"] = Value::String(target);
                    report.translated_items.push(mapped);
                }
            }
            Err(error) if error.to_string().contains(MANUAL_STOP) => return Err(error),
            Err(error) => {
                let mut grouped = HashMap::<usize, Vec<BatchTaskFailureItem>>::new();
                for item in batch {
                    let resource_state_index =
                        item.get("resourceStateIndex")
                            .and_then(Value::as_u64)
                            .unwrap_or(usize::MAX as u64) as usize;
                    grouped
                        .entry(resource_state_index)
                        .or_default()
                        .push(packed_failure_item(item));
                }
                for (resource_state_index, items) in grouped {
                    report.failures.push(PackedBatchFailure {
                        resource_state_index,
                        error_message: error.to_string(),
                        items,
                    });
                }
            }
        }
    }

    Ok(report)
}

fn apply_packed_translation_report(
    resource_states: &mut [BatchResourceState],
    report: PackedBatchReport,
    batch_type: &str,
    is_plugin: bool,
) {
    for item in report.translated_items {
        let resource_state_index = item
            .get("resourceStateIndex")
            .and_then(Value::as_u64)
            .unwrap_or(usize::MAX as u64) as usize;
        let Some(resource_state) = resource_states.get_mut(resource_state_index) else {
            continue;
        };
        let index = item
            .get("dictIndex")
            .and_then(Value::as_u64)
            .unwrap_or(usize::MAX as u64) as usize;
        let Some(target) = item.get("target").and_then(Value::as_str) else {
            continue;
        };
        let pointer = if is_plugin {
            let file = item.get("file").and_then(Value::as_str).unwrap_or_default();
            format!(
                "/dict/{}/{}/{}/target",
                escape_pointer(file),
                batch_type,
                index
            )
        } else {
            format!("/dict/{}/target", index)
        };
        if let Some(target_slot) = resource_state.translation_json.pointer_mut(&pointer) {
            *target_slot = Value::String(target.to_string());
            resource_state.processed_items += 1;
        }
    }

    for failure in report.failures {
        let Some(resource_state) = resource_states.get_mut(failure.resource_state_index) else {
            continue;
        };
        resource_state.failures.push(CompanionBatchFailure {
            resource_id: resource_state.resource.resource_id.clone(),
            resource_label: resource_state.resource.label.clone(),
            source_id: resource_state.source_id.clone(),
            batch_type: batch_type.to_string(),
            error_message: failure.error_message,
            items: failure.items,
        });
    }
}

fn fallback_target(item: &Value) -> String {
    item.get("target")
        .and_then(Value::as_str)
        .or_else(|| item.get("source").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

fn packed_failure_item(item: &Value) -> BatchTaskFailureItem {
    BatchTaskFailureItem {
        source: item
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        target: fallback_target(item),
        dict_index: item.get("dictIndex").and_then(Value::as_i64).unwrap_or(-1) as isize,
        file: non_empty_string(item.get("file")),
        r#type: non_empty_string(item.get("type")),
        name: non_empty_string(item.get("name")),
    }
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslateResult {
    translation_json: Value,
    processed_items: usize,
    failures: Vec<CompanionBatchFailure>,
}

async fn handle_plugin_translate(
    payload: Value,
    task: Option<Arc<TaskRuntime>>,
) -> Result<TranslateResult> {
    let mut translation_json = payload
        .get("translationJson")
        .cloned()
        .unwrap_or(Value::Null);
    let config: CompanionTranslationConfig =
        serde_json::from_value(payload.get("config").cloned().unwrap_or(Value::Null))?;
    let resource_id = payload
        .get("resourceId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let resource_label = payload
        .get("resourceLabel")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let source_id = payload
        .get("sourceId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let mut ast_items = Vec::<Value>::new();
    let mut regex_items = Vec::<Value>::new();
    let mut next_id = 0usize;
    if let Some(dict) = translation_json.get("dict").and_then(Value::as_object) {
        for (file, file_dict) in dict {
            if let Some(ast) = file_dict.get("ast").and_then(Value::as_array) {
                for (index, item) in ast.iter().enumerate() {
                    if should_translate(item.get("target"), item.get("source")) {
                        ast_items.push(json!({ "id": next_id, "file": file, "dictIndex": index, "type": item.get("type").and_then(Value::as_str).unwrap_or(""), "name": item.get("name").and_then(Value::as_str).unwrap_or(""), "source": item.get("source").and_then(Value::as_str).unwrap_or(""), "target": item.get("target").and_then(Value::as_str).unwrap_or("") }));
                        next_id += 1;
                    }
                }
            }
            if let Some(regex) = file_dict.get("regex").and_then(Value::as_array) {
                for (index, item) in regex.iter().enumerate() {
                    if should_translate(item.get("target"), item.get("source")) {
                        regex_items.push(json!({ "id": next_id, "file": file, "dictIndex": index, "source": item.get("source").and_then(Value::as_str).unwrap_or(""), "target": item.get("target").and_then(Value::as_str).unwrap_or("") }));
                        next_id += 1;
                    }
                }
            }
        }
    }

    let mut failures = Vec::new();
    let mut processed_items = 0usize;
    let ast_result = translate_value_batches(&ast_items, &config.prompts.ast, &config, |item| json!({ "i": item["id"], "s": item["source"], "y": item["type"], "n": item["name"] }), task.clone()).await;
    apply_plugin_batch_result(
        &mut translation_json,
        ast_result,
        "ast",
        &resource_id,
        &resource_label,
        &source_id,
        &mut failures,
        &mut processed_items,
    )?;
    let regex_result = translate_value_batches(
        &regex_items,
        &config.prompts.regex,
        &config,
        |item| json!({ "i": item["id"], "s": item["source"] }),
        task.clone(),
    )
    .await;
    apply_plugin_batch_result(
        &mut translation_json,
        regex_result,
        "regex",
        &resource_id,
        &resource_label,
        &source_id,
        &mut failures,
        &mut processed_items,
    )?;

    Ok(TranslateResult {
        translation_json,
        processed_items,
        failures,
    })
}

fn apply_plugin_batch_result(
    translation_json: &mut Value,
    result: Result<Vec<Value>>,
    batch_type: &str,
    resource_id: &str,
    resource_label: &str,
    source_id: &str,
    failures: &mut Vec<CompanionBatchFailure>,
    processed_items: &mut usize,
) -> Result<()> {
    match result {
        Ok(items) => {
            for item in &items {
                let file = item.get("file").and_then(Value::as_str).unwrap_or_default();
                let index = item
                    .get("dictIndex")
                    .and_then(Value::as_u64)
                    .unwrap_or(usize::MAX as u64) as usize;
                if let Some(target) = item.get("target").and_then(Value::as_str) {
                    if let Some(target_slot) = translation_json.pointer_mut(&format!(
                        "/dict/{}/{}/{}/target",
                        escape_pointer(file),
                        batch_type,
                        index
                    )) {
                        *target_slot = Value::String(target.to_string());
                    }
                }
            }
            *processed_items += items.len();
        }
        Err(error) if error.to_string().contains(MANUAL_STOP) => return Err(error),
        Err(error) => {
            failures.push(CompanionBatchFailure {
                resource_id: resource_id.to_string(),
                resource_label: resource_label.to_string(),
                source_id: source_id.to_string(),
                batch_type: batch_type.to_string(),
                error_message: error.to_string(),
                items: Vec::new(),
            });
        }
    }
    Ok(())
}

async fn handle_theme_translate(
    payload: Value,
    task: Option<Arc<TaskRuntime>>,
) -> Result<TranslateResult> {
    let mut translation_json = payload
        .get("translationJson")
        .cloned()
        .unwrap_or(Value::Null);
    let config: CompanionTranslationConfig =
        serde_json::from_value(payload.get("config").cloned().unwrap_or(Value::Null))?;
    let resource_id = payload
        .get("resourceId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let resource_label = payload
        .get("resourceLabel")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let source_id = payload
        .get("sourceId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let items: Vec<Value> = translation_json.get("dict").and_then(Value::as_array).map(|dict| {
        dict.iter().enumerate()
            .filter(|(_, item)| should_translate(item.get("target"), item.get("source")))
            .map(|(index, item)| json!({ "id": index, "dictIndex": index, "type": item.get("type").and_then(Value::as_str).unwrap_or(""), "source": item.get("source").and_then(Value::as_str).unwrap_or(""), "target": item.get("target").and_then(Value::as_str).unwrap_or("") }))
            .collect()
    }).unwrap_or_default();

    let result = translate_value_batches(
        &items,
        &config.prompts.theme,
        &config,
        |item| json!({ "i": item["id"], "s": item["source"], "y": item["type"] }),
        task,
    )
    .await;
    let mut failures = Vec::new();
    let mut processed_items = 0;
    match result {
        Ok(items) => {
            for item in &items {
                let index = item
                    .get("dictIndex")
                    .and_then(Value::as_u64)
                    .unwrap_or(usize::MAX as u64) as usize;
                if let Some(target) = item.get("target").and_then(Value::as_str) {
                    if let Some(target_slot) =
                        translation_json.pointer_mut(&format!("/dict/{}/target", index))
                    {
                        *target_slot = Value::String(target.to_string());
                    }
                }
            }
            processed_items += items.len();
        }
        Err(error) if error.to_string().contains(MANUAL_STOP) => return Err(error),
        Err(error) => failures.push(CompanionBatchFailure {
            resource_id,
            resource_label,
            source_id,
            batch_type: "theme".to_string(),
            error_message: error.to_string(),
            items: Vec::new(),
        }),
    }
    Ok(TranslateResult {
        translation_json,
        processed_items,
        failures,
    })
}

async fn translate_value_batches<F>(
    items: &[Value],
    prompt: &str,
    config: &CompanionTranslationConfig,
    simplify: F,
    task: Option<Arc<TaskRuntime>>,
) -> Result<Vec<Value>>
where
    F: Fn(&Value) -> Value,
{
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let mut output = Vec::new();
    for batch in items.chunks(config.batch_size.max(1)) {
        if let Some(task) = &task {
            ensure_not_cancelled(task).await?;
        }
        let simplified: Vec<Value> = batch.iter().map(&simplify).collect();
        let translated = if let Some(task) = &task {
            let _permit = task.ai_lock.acquire().await?;
            ensure_not_cancelled(task).await?;
            let result = call_chat_completion(&simplified, prompt, config).await;
            ensure_not_cancelled(task).await?;
            result?
        } else {
            call_chat_completion(&simplified, prompt, config).await?
        };
        for item in batch {
            let id = item.get("id").and_then(Value::as_u64).unwrap_or(0);
            let mut mapped = item.clone();
            let target = translated
                .iter()
                .find(|entry| entry.i == id)
                .map(|entry| entry.t.clone())
                .filter(|value| !value.trim().is_empty() && value.trim() != "空")
                .unwrap_or_else(|| {
                    item.get("target")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("source").and_then(Value::as_str))
                        .unwrap_or_default()
                        .to_string()
                });
            mapped["target"] = Value::String(target);
            output.push(mapped);
        }
    }
    Ok(output)
}

#[derive(Debug, Clone)]
struct TranslationPair {
    i: u64,
    t: String,
}

async fn call_chat_completion(
    items: &[Value],
    system_prompt: &str,
    config: &CompanionTranslationConfig,
) -> Result<Vec<TranslationPair>> {
    let started = now_ms();
    let timeout_ms = config.timeout_ms.max(1000);
    let mut request = json!({
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": serde_json::to_string(items)? }
        ],
        "model": config.model,
        "temperature": 0.3,
        "stream": true,
    });
    if config.response_format == "json_object" {
        request["response_format"] = json!({ "type": "json_object" });
    } else if config.response_format == "json_schema" {
        request["response_format"] = json!({
            "type": "json_schema",
            "json_schema": {
                "name": "translation_result",
                "schema": {
                    "type": "object",
                    "properties": { "items": { "type": "array", "items": { "type": "object", "properties": { "i": { "type": "number" }, "t": { "type": "string" } }, "required": ["i", "t"], "additionalProperties": false } } },
                    "required": ["items"],
                    "additionalProperties": false
                },
                "strict": true
            }
        });
    }

    let client = reqwest::Client::new();
    let response = client
        .post(&config.chat_completions_url)
        .timeout(Duration::from_millis(timeout_ms))
        .header("content-type", "application/json")
        .bearer_auth(&config.api_key)
        .body(request.to_string())
        .send()
        .await
        .map_err(|error| normalize_ai_error(error, started, timeout_ms))?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or_default().to_string();
    let text = response
        .text()
        .await
        .map_err(|error| normalize_ai_error(error, started, timeout_ms))?;
    let body = normalize_streaming_response_text(&text);
    if !status.is_success() {
        let mut message = format!(
            "HTTP {}{}",
            status.as_u16(),
            if status_text.is_empty() {
                String::new()
            } else {
                format!(" {status_text}")
            }
        );
        if let Ok(value) = serde_json::from_str::<Value>(&body) {
            if let Some(upstream) = value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
            {
                message.push_str(&format!("，{upstream}"));
            }
            if let Some(code) = value
                .pointer("/error/code")
                .or_else(|| value.get("code"))
                .and_then(Value::as_str)
            {
                message.push_str(&format!("，code={code}"));
            }
            if let Some(kind) = value
                .pointer("/error/type")
                .or_else(|| value.get("type"))
                .and_then(Value::as_str)
            {
                message.push_str(&format!("，type={kind}"));
            }
        } else if !body.is_empty() {
            message.push_str(&format!("，{}", body.chars().take(200).collect::<String>()));
        }
        return Err(anyhow!(
            "AI 端点返回异常（耗时 {}）：{}",
            format_duration(now_ms() - started),
            message
        ));
    }

    let parsed: Value = serde_json::from_str(&body).map_err(|_| {
        anyhow!(
            "AI 返回非 JSON 响应（耗时 {}）：{}",
            format_duration(now_ms() - started),
            body.chars().take(200).collect::<String>()
        )
    })?;
    let assistant = parsed
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow!(
                "AI 返回缺少 message.content（耗时 {}）",
                format_duration(now_ms() - started)
            )
        })?;
    parse_translation_response(assistant).map_err(|error| {
        anyhow!(
            "AI 翻译结果解析失败（耗时 {}）：{}",
            format_duration(now_ms() - started),
            error
        )
    })
}

fn normalize_ai_error(error: reqwest::Error, started: u64, timeout_ms: u64) -> anyhow::Error {
    let prefix = if error.is_timeout() {
        "AI 请求超时"
    } else {
        "AI 请求失败"
    };
    anyhow!(
        "{}（耗时 {}，超时 {}）：{}",
        prefix,
        format_duration(now_ms() - started),
        format_duration(timeout_ms),
        error
    )
}

fn normalize_streaming_response_text(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with("data:") {
        return text.to_string();
    }
    let mut chunks = String::new();
    let mut last_event = Value::Null;
    let mut error_event = Value::Null;
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with("data:") {
            continue;
        }
        let payload = line.trim_start_matches("data:").trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        if let Ok(event) = serde_json::from_str::<Value>(payload) {
            last_event = event.clone();
            if event.get("error").is_some() {
                error_event = event.clone();
            }
            if let Some(content) = event
                .pointer("/choices/0/delta/content")
                .or_else(|| event.pointer("/choices/0/message/content"))
                .and_then(Value::as_str)
            {
                chunks.push_str(content);
            }
        }
    }
    if chunks.is_empty() && !error_event.is_null() {
        return error_event.to_string();
    }
    if chunks.is_empty() {
        return text.to_string();
    }
    json!({
        "id": last_event.get("id").cloned().unwrap_or_else(|| json!("companion-worker-stream")),
        "object": "chat.completion",
        "created": last_event.get("created").cloned().unwrap_or_else(|| json!(now_ms() / 1000)),
        "model": last_event.get("model").cloned().unwrap_or_else(|| json!("")),
        "choices": [{ "index": 0, "message": { "role": "assistant", "content": chunks }, "finish_reason": last_event.pointer("/choices/0/finish_reason").cloned().unwrap_or_else(|| json!("stop")) }],
        "usage": last_event.get("usage").cloned().unwrap_or(Value::Null),
    }).to_string()
}

fn parse_translation_response(content: &str) -> Result<Vec<TranslationPair>> {
    if content.trim().is_empty() {
        return Err(anyhow!("AI 返回内容为空"));
    }
    let mut text = content.trim().to_string();
    let code_re = Regex::new(r"(?s)```(?:json)?\s*(.*?)\s*```").unwrap();
    if let Some(captures) = code_re.captures(&text) {
        text = captures
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or(text);
    } else {
        let first = [text.find('['), text.find('{')].into_iter().flatten().min();
        let last = [text.rfind(']'), text.rfind('}')]
            .into_iter()
            .flatten()
            .max();
        if let (Some(first), Some(last)) = (first, last) {
            if last > first {
                text = text[first..=last].to_string();
            }
        }
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
        if let Ok(items) = extract_translation_array(&parsed) {
            if !items.is_empty() {
                return Ok(items);
            }
        }
    }
    let cleaned = Regex::new(r"[\u{0000}-\u{001F}]+")?
        .replace_all(&text, " ")
        .to_string();
    let cleaned = Regex::new(r",\s*([\]}])")?
        .replace_all(&cleaned, "$1")
        .to_string();
    if let Ok(parsed) = serde_json::from_str::<Value>(&cleaned) {
        if let Ok(items) = extract_translation_array(&parsed) {
            if !items.is_empty() {
                return Ok(items);
            }
        }
    }

    let fallback_re = Regex::new(r#""i"\s*:\s*(\d+)\s*,\s*"t"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)""#)?;
    let mut output = Vec::new();
    for captures in fallback_re.captures_iter(content) {
        let i = captures.get(1).unwrap().as_str().parse::<u64>()?;
        let raw = captures.get(2).unwrap().as_str();
        let t = serde_json::from_str::<String>(&format!("\"{}\"", raw)).unwrap_or_else(|_| {
            raw.replace("\\n", "\n")
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
        });
        output.push(TranslationPair { i, t });
    }
    if output.is_empty() {
        Err(anyhow!(
            "AI 返回数据格式严重损坏，正则急救也未能提取到业务结构 ({{i, t}})。"
        ))
    } else {
        Ok(output)
    }
}

fn extract_translation_array(value: &Value) -> Result<Vec<TranslationPair>> {
    let array = if let Some(array) = value.as_array() {
        array.clone()
    } else if let Some(object) = value.as_object() {
        if object.contains_key("i") && object.contains_key("t") {
            vec![value.clone()]
        } else {
            object
                .values()
                .find_map(|value| value.as_array().cloned())
                .ok_or_else(|| {
                    anyhow!(
                        "无法从返回信息中识别提取数组: {}",
                        value.to_string().chars().take(200).collect::<String>()
                    )
                })?
        }
    } else {
        return Err(anyhow!("无法从返回信息中识别提取数组: {}", value));
    };
    Ok(array
        .into_iter()
        .filter_map(|item| {
            Some(TranslationPair {
                i: item.get("i")?.as_u64()?,
                t: item.get("t")?.as_str()?.to_string(),
            })
        })
        .collect())
}

fn should_translate(target: Option<&Value>, source: Option<&Value>) -> bool {
    let target = target.and_then(Value::as_str).unwrap_or_default();
    let source = source.and_then(Value::as_str).unwrap_or_default();
    target.trim().is_empty() || target == source
}

fn count_pending_plugin_items(json: &Value) -> usize {
    json.get("dict")
        .and_then(Value::as_object)
        .map(|dict| {
            dict.values()
                .map(|file| {
                    let ast = file
                        .get("ast")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter(|item| {
                                    should_translate(item.get("target"), item.get("source"))
                                })
                                .count()
                        })
                        .unwrap_or(0);
                    let regex = file
                        .get("regex")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter(|item| {
                                    should_translate(item.get("target"), item.get("source"))
                                })
                                .count()
                        })
                        .unwrap_or(0);
                    ast + regex
                })
                .sum()
        })
        .unwrap_or(0)
}

fn count_pending_theme_items(json: &Value) -> usize {
    json.get("dict")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| should_translate(item.get("target"), item.get("source")))
                .count()
        })
        .unwrap_or(0)
}

async fn handle_plugin_retry(payload: Value, task: Option<Arc<TaskRuntime>>) -> Result<Value> {
    let mut completed_ids = Vec::new();
    let mut failed_ids = Vec::new();
    let mut skipped_ids = Vec::new();
    let mut updates = Vec::new();
    let config = payload.get("config").cloned().unwrap_or(Value::Null);
    let failures = payload
        .get("failures")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let resource_id = payload
        .get("resourceId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let resource_label = payload
        .get("resourceLabel")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let source_id = payload
        .get("sourceId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut processed_items = 0usize;
    for failure in failures {
        let batch_type = failure
            .get("batchType")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if batch_type != "ast" && batch_type != "regex" {
            skipped_ids.push(
                failure
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            continue;
        }
        let items: Vec<Value> = failure
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .map(|(id, item)| {
                json!({
                    "id": id,
                    "failureId": failure.get("id").and_then(Value::as_str).unwrap_or_default(),
                    "file": item.get("file").and_then(Value::as_str).unwrap_or_default(),
                    "dictIndex": item.get("dictIndex").and_then(Value::as_i64).unwrap_or(-1),
                    "type": item.get("type").and_then(Value::as_str).unwrap_or(""),
                    "name": item.get("name").and_then(Value::as_str).unwrap_or(""),
                    "source": item.get("source").and_then(Value::as_str).unwrap_or(""),
                    "target": item.get("target").and_then(Value::as_str).unwrap_or(""),
                })
            })
            .collect();
        if items.is_empty() {
            skipped_ids.push(
                failure
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            continue;
        }
        let translate_payload = json!({ "resourceId": resource_id, "resourceLabel": resource_label, "sourceId": source_id, "translationJson": { "dict": {} }, "config": config });
        let cfg: CompanionTranslationConfig =
            serde_json::from_value(translate_payload["config"].clone())?;
        let result = translate_value_batches(&items, if batch_type == "ast" { &cfg.prompts.ast } else { &cfg.prompts.regex }, &cfg, |item| if batch_type == "ast" { json!({ "i": item["id"], "s": item["source"], "y": item["type"], "n": item["name"] }) } else { json!({ "i": item["id"], "s": item["source"] }) }, task.clone()).await;
        match result {
            Ok(result_items) => {
                processed_items += result_items.len();
                for item in result_items {
                    updates.push(json!({ "batchType": batch_type, "failureId": item["failureId"], "file": item["file"], "dictIndex": item["dictIndex"], "target": item["target"] }));
                }
                completed_ids.push(
                    failure
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                );
            }
            Err(error) if error.to_string().contains(MANUAL_STOP) => return Err(error),
            Err(_) => failed_ids.push(
                failure
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            ),
        }
    }
    Ok(
        json!({ "updates": updates, "processedItems": processed_items, "completedFailureIds": completed_ids, "failedFailureIds": failed_ids, "skippedFailureIds": skipped_ids }),
    )
}

async fn handle_theme_retry(payload: Value, task: Option<Arc<TaskRuntime>>) -> Result<Value> {
    let config: CompanionTranslationConfig =
        serde_json::from_value(payload.get("config").cloned().unwrap_or(Value::Null))?;
    let failures = payload
        .get("failures")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut completed_ids = Vec::new();
    let mut failed_ids = Vec::new();
    let mut skipped_ids = Vec::new();
    let mut updates = Vec::new();
    let mut processed_items = 0usize;
    for failure in failures {
        if failure.get("batchType").and_then(Value::as_str) != Some("theme") {
            skipped_ids.push(
                failure
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            continue;
        }
        let items: Vec<Value> = failure
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .map(|(id, item)| {
                json!({
                    "id": id,
                    "failureId": failure.get("id").and_then(Value::as_str).unwrap_or_default(),
                    "dictIndex": item.get("dictIndex").and_then(Value::as_i64).unwrap_or(-1),
                    "type": item.get("type").and_then(Value::as_str).unwrap_or(""),
                    "source": item.get("source").and_then(Value::as_str).unwrap_or(""),
                    "target": item.get("target").and_then(Value::as_str).unwrap_or(""),
                })
            })
            .collect();
        if items.is_empty() {
            skipped_ids.push(
                failure
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            continue;
        }
        let result = translate_value_batches(
            &items,
            &config.prompts.theme,
            &config,
            |item| json!({ "i": item["id"], "s": item["source"], "y": item["type"] }),
            task.clone(),
        )
        .await;
        match result {
            Ok(result_items) => {
                processed_items += result_items.len();
                for item in result_items {
                    updates.push(json!({ "failureId": item["failureId"], "dictIndex": item["dictIndex"], "target": item["target"] }));
                }
                completed_ids.push(
                    failure
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                );
            }
            Err(error) if error.to_string().contains(MANUAL_STOP) => return Err(error),
            Err(_) => failed_ids.push(
                failure
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            ),
        }
    }
    Ok(
        json!({ "updates": updates, "processedItems": processed_items, "completedFailureIds": completed_ids, "failedFailureIds": failed_ids, "skippedFailureIds": skipped_ids }),
    )
}

async fn handle_plugin_failure_retry(
    state: &AppState,
    task: Arc<TaskRuntime>,
    payload: Value,
) -> Result<()> {
    handle_failure_retry(state, task, payload, true).await
}

async fn handle_theme_failure_retry(
    state: &AppState,
    task: Arc<TaskRuntime>,
    payload: Value,
) -> Result<()> {
    handle_failure_retry(state, task, payload, false).await
}

async fn handle_failure_retry(
    state: &AppState,
    task: Arc<TaskRuntime>,
    payload: Value,
    is_plugin: bool,
) -> Result<()> {
    let retry: FailureRetryPayload = serde_json::from_value(payload.clone())?;
    let paths = paths(&retry.persistence.base_path);
    let mut groups: HashMap<String, Vec<BatchTaskFailureRecord>> = HashMap::new();
    for failure in retry.failures {
        groups
            .entry(failure.source_id.clone())
            .or_default()
            .push(failure);
    }
    for failures in groups.into_values() {
        if !is_task_active(&task).await {
            break;
        }
        let first = failures.first().cloned().context("empty failure group")?;
        touch_progress(&task, json!({ "currentLabel": first.resource_label })).await;
        let Some(mut translation_json) = read_translation(&paths, &first.source_id) else {
            increment_progress(&task, "skippedCount", failures.len()).await;
            increment_progress(&task, "processedResources", failures.len()).await;
            continue;
        };
        let payload = json!({ "resourceId": first.resource_id, "resourceLabel": first.resource_label, "sourceId": first.source_id, "failures": failures, "config": retry.config });
        let result = if is_plugin {
            handle_plugin_retry(payload, Some(task.clone())).await
        } else {
            handle_theme_retry(payload, Some(task.clone())).await
        }?;
        if let Some(updates) = result.get("updates").and_then(Value::as_array) {
            for update in updates {
                if is_plugin {
                    let batch_type = update
                        .get("batchType")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let file = update
                        .get("file")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let index = update
                        .get("dictIndex")
                        .and_then(Value::as_u64)
                        .unwrap_or(usize::MAX as u64) as usize;
                    if let Some(slot) = translation_json.pointer_mut(&format!(
                        "/dict/{}/{}/{}/target",
                        escape_pointer(file),
                        batch_type,
                        index
                    )) {
                        *slot = update
                            .get("target")
                            .cloned()
                            .unwrap_or(Value::String(String::new()));
                    }
                } else {
                    let index = update
                        .get("dictIndex")
                        .and_then(Value::as_u64)
                        .unwrap_or(usize::MAX as u64) as usize;
                    if let Some(slot) =
                        translation_json.pointer_mut(&format!("/dict/{}/target", index))
                    {
                        *slot = update
                            .get("target")
                            .cloned()
                            .unwrap_or(Value::String(String::new()));
                    }
                }
            }
        }
        save_translated_source(state, &paths, &first.source_id, &translation_json).await?;
        let completed: Vec<String> = result
            .get("completedFailureIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        remove_failures(state, &paths, &completed).await?;
        increment_progress(
            &task,
            "processedItems",
            result
                .get("processedItems")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
        )
        .await;
        increment_progress(&task, "successCount", completed.len()).await;
        increment_progress(
            &task,
            "failedCount",
            result
                .get("failedFailureIds")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0),
        )
        .await;
        increment_progress(
            &task,
            "skippedCount",
            result
                .get("skippedFailureIds")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0),
        )
        .await;
        increment_progress(&task, "processedResources", 1).await;
        bump_source_revision(&task).await;
        bump_record_revision(&task).await;
    }
    Ok(())
}

fn calculate_checksum(value: &Value) -> Result<String> {
    let mut value = value.clone();
    if let Some(obj) = value.as_object_mut() {
        obj.remove("checksum");
    }
    let stable = stable_stringify(&value);
    let mut hasher = Sha256::new();
    hasher.update(stable.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_default(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(stable_stringify)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        stable_stringify(&map[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn escape_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn format_duration(ms: u64) -> String {
    format!("{:.1}s", ms as f64 / 1000.0)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
