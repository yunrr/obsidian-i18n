use anyhow::{anyhow, bail, Context, Result};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::DateTime;
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use nanoid::nanoid;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{Read as IoRead, Write as IoWrite},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use swc_common::{sync::Lrc, FileName, SourceMap};
use swc_ecma_ast::*;
use swc_ecma_codegen::{text_writer::JsWriter, Emitter};
use swc_ecma_parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};
use swc_ecma_visit::{Visit, VisitMut, VisitMutWith, VisitWith};
use tokio::{
    io::AsyncReadExt,
    sync::{oneshot, Mutex, Semaphore},
    task::JoinSet,
    time::timeout as tokio_timeout,
};
use url::Url;

const HOST: &str = "127.0.0.1";
const MANUAL_STOP: &str = "批量任务已手动停止";
const EXTRACT_CHECKPOINT_EVERY_RESOURCES: usize = 100;
const EXTRACT_CHECKPOINT_EVERY_MS: u64 = 10_000;
const MAX_EXTRACT_CPU_CONCURRENCY: usize = 32;
const CLOUD_BACKUP_CHUNK_SIZE: usize = 20;
const DEFAULT_TRANSLATE_WINDOW_BATCH_MULTIPLIER: usize = 4;

#[derive(Clone)]
struct AppState {
    tasks: Arc<Mutex<HashMap<String, Arc<TaskRuntime>>>>,
    diagnose_sessions: Arc<Mutex<HashMap<String, DiagnoseCleanupSession>>>,
    persistence_lock: Arc<Mutex<()>>,
    plugin_dir: PathBuf,
    http: reqwest::Client,
    shutdown: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

struct TaskRuntime {
    progress: Mutex<CompanionTaskProgress>,
    cancel_requested: Mutex<bool>,
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
struct AstReplacePayload {
    code: String,
    translations: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodeExtractPayload {
    code: String,
    settings: ExtractionSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginApplyTranslationPayload {
    plugin_id: String,
    plugin_dir: String,
    backup_base_path: String,
    #[serde(default)]
    translation_json: Option<Value>,
    #[serde(default)]
    persistence: Option<PersistenceConfig>,
    #[serde(default)]
    translation_source_id: Option<String>,
    #[serde(default)]
    apply_ast: Option<bool>,
    #[serde(default)]
    apply_regex: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginDiagnoseCleanupStartPayload {
    plugin_id: String,
    plugin_dir: String,
    backup_base_path: String,
    persistence: PersistenceConfig,
    translation_source_id: String,
    #[serde(default)]
    apply_ast: Option<bool>,
    #[serde(default)]
    apply_regex: Option<bool>,
    #[serde(default)]
    runtime_probe: Option<bool>,
    #[serde(default)]
    is_applied: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginDiagnoseCleanupStepPayload {
    session_id: String,
    probe_id: String,
    success: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemeApplyTranslationPayload {
    theme_id: String,
    theme_dir: String,
    theme_css_path: String,
    #[serde(default)]
    theme_css_relative_path: Option<String>,
    backup_base_path: String,
    #[serde(default)]
    translation_json: Option<Value>,
    #[serde(default)]
    persistence: Option<PersistenceConfig>,
    #[serde(default)]
    translation_source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyTranslationResponse {
    state: bool,
    processed_files: usize,
    translation_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
struct TranslationIssueItem {
    file: String,
    kind: String,
    index: usize,
    source: String,
    target: String,
    reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationCleanupReport {
    state: bool,
    removed_items: Vec<TranslationIssueItem>,
    processed_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeProbeFile {
    file: String,
    code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeProbeRequest {
    probe_id: String,
    files: Vec<RuntimeProbeFile>,
    label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginDiagnoseCleanupResponse {
    state: bool,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    probe: Option<RuntimeProbeRequest>,
    removed_items: Vec<TranslationIssueItem>,
    processed_files: usize,
    translation_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceManagerPayload {
    persistence: PersistenceConfig,
    #[serde(default)]
    source_id: Option<String>,
    #[serde(default)]
    source_ids: Vec<String>,
    #[serde(default)]
    checkpoint_keys: Vec<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    active: Option<bool>,
    #[serde(default)]
    content_base64: Option<String>,
    #[serde(default)]
    file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceImportExportResponse {
    state: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<Value>,
    added_count: usize,
    updated_count: usize,
    skipped_count: usize,
    deleted_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubReadRequest {
    operation: String,
    token: Option<String>,
    github_proxy_url: Option<String>,
    owner: Option<String>,
    repo: Option<String>,
    path: Option<String>,
    branch: Option<String>,
    r#ref: Option<String>,
    username: Option<String>,
    repo_name: Option<String>,
    url: Option<String>,
    target_owner: Option<String>,
    target_repo: Option<String>,
    repo_address: Option<String>,
    creator: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
    recursive: Option<bool>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubReadResponse {
    state: bool,
    data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scopes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_rate_limit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    has_open_issue: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubWriteRequest {
    operation: String,
    token: Option<String>,
    owner: Option<String>,
    repo: Option<String>,
    name: Option<String>,
    path: Option<String>,
    content: Option<String>,
    message: Option<String>,
    branch: Option<String>,
    sha: Option<String>,
    title: Option<String>,
    body: Option<String>,
    label: Option<String>,
    target_owner: Option<String>,
    target_repo: Option<String>,
    base_tree: Option<String>,
    tree_data: Option<Vec<Value>>,
    tree: Option<String>,
    parents: Option<Vec<String>>,
    r#ref: Option<String>,
    files: Option<Vec<GithubBatchUploadFile>>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubBatchUploadFile {
    path: String,
    content: String,
}

type GithubWriteResponse = GithubReadResponse;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationMatchRequest {
    matches: Vec<AutomationMatchCandidate>,
    stats: Value,
    target_version: String,
    target_language: String,
    is_theme: bool,
    strategy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationMatchCandidate {
    repo_address: String,
    entry: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationMatchResponse {
    #[serde(rename = "match")]
    match_: Option<AutomationMatchCandidate>,
    score_info: ScoreInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScoreInfo {
    version: i64,
    popularity: i64,
    freshness: i64,
    total: i64,
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
    #[serde(default)]
    batch_char_limit: usize,
    #[serde(default = "default_translate_window_batch_multiplier")]
    batch_window_multiplier: usize,
    #[serde(default)]
    overwrite_existing_translations: bool,
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
    config: CompanionTranslationConfig,
    concurrency: usize,
    #[serde(default)]
    total_resources: Option<usize>,
    #[serde(default)]
    total_items: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractBatchPayload {
    persistence: PersistenceConfig,
    resources: Vec<Value>,
    concurrency: usize,
    checkpoint_key: String,
    #[serde(default)]
    language: String,
    #[serde(default)]
    settings: ExtractionSettings,
    #[serde(default = "default_translation_version")]
    translation_version: String,
    #[serde(default)]
    completed_resources: Option<usize>,
    #[serde(default)]
    total_resources: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudTaskPayload {
    persistence: PersistenceConfig,
    token: Option<String>,
    owner: String,
    repo: String,
    #[serde(default = "default_branch")]
    branch: String,
    #[serde(default)]
    language: String,
    #[serde(default)]
    entry: Value,
    source_id: Option<String>,
    title: Option<String>,
    description: Option<String>,
    version: Option<String>,
    #[serde(default)]
    sources: Vec<Value>,
    #[serde(default)]
    manifest: Vec<Value>,
    #[serde(default)]
    overwrite: bool,
    #[serde(default)]
    resume: bool,
}

fn default_branch() -> String {
    "main".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ExtractionSettings {
    #[serde(default)]
    author: String,
    #[serde(default = "default_translation_version")]
    translation_version: String,
    #[serde(default = "default_re_flags")]
    re_flags: String,
    #[serde(default = "default_max_length")]
    re_length: usize,
    #[serde(default)]
    re_datas: Vec<String>,
    #[serde(default)]
    re_reject_re: Vec<String>,
    #[serde(default)]
    re_valid_re: Vec<String>,
    #[serde(default = "default_enabled")]
    re_extraction_enabled: bool,
    #[serde(default = "default_chinese_skip_mode")]
    chinese_skip_mode: String,
    #[serde(default)]
    ast_assignments: Vec<String>,
    #[serde(default)]
    ast_functions: Vec<String>,
    #[serde(default)]
    ast_keys: Vec<String>,
    #[serde(default = "default_max_length")]
    ast_max_length: usize,
    #[serde(default)]
    ast_reject_re: Vec<String>,
    #[serde(default)]
    ast_valid_re: Vec<String>,
    #[serde(default = "default_enabled")]
    ast_extraction_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginExtractPayload {
    resource_id: String,
    label: String,
    plugin_name: String,
    plugin_version: String,
    main_doc: String,
    manifest_doc: String,
    language: String,
    settings: ExtractionSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemeExtractPayload {
    resource_id: String,
    label: String,
    theme_name: String,
    theme_dir: String,
    theme_css_path: String,
    #[serde(default)]
    theme_css_relative_path: Option<String>,
    #[serde(default)]
    is_legacy: bool,
    settings: ExtractionSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanionExtractResult {
    status: String,
    resource_id: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct AstMatch {
    node_type: String,
    name: String,
    source: String,
}

struct SwcAstConfig {
    assignments: HashSet<String>,
    functions: HashSet<String>,
    keys: HashSet<String>,
    reject: Vec<Regex>,
    valid: Vec<Regex>,
    max_length: usize,
}

impl SwcAstConfig {
    fn from_settings(settings: &ExtractionSettings) -> Self {
        let assignments = if settings.ast_assignments.is_empty() {
            vec!["overwriteName", "innerHTML", "outerHTML", "title", "alt", "placeholder", "textContent", "innerText", "ariaLabel", "nodeValue", "buttonText", "confirmText", "cancelText", "labelText"]
                .into_iter().map(str::to_string).collect()
        } else {
            settings.ast_assignments.clone()
        };
        let functions = if settings.ast_functions.is_empty() {
            vec!["Notice", "setTitle", "setContent", "setName", "setDesc", "setButtonText", "setPlaceholder", "setTooltip", "addOption", "addOptions", "addHeading", "addText", "setHint", "setWarning", "setText", "appendText", "createEl", "createDiv", "createSpan", "addCommand", "insertText", "replaceRange", "replaceSelection", "log", "error", "warn", "info", "alert", "confirm", "prompt", "renderMarkdown", "setLabel", "setConfirmText", "setCancelText"]
                .into_iter().map(str::to_string).collect()
        } else {
            settings.ast_functions.clone()
        };
        let keys = if settings.ast_keys.is_empty() {
            vec!["name", "description", "text", "placeholder", "label", "tooltip", "title", "header", "desc", "message", "buttontext", "aria-label", "heading", "content", "tab", "caption", "subtitle", "summary", "info", "warning", "error", "success", "hint", "instructions", "link", "selection", "annotation", "search", "speech", "page", "empty", "detail", "body", "option", "notice", "confirmText", "cancelText", "ariaLabel", "buttonText"]
                .into_iter().map(str::to_string).collect()
        } else {
            settings.ast_keys.clone()
        };
        Self {
            assignments: assignments.into_iter().collect(),
            functions: functions.into_iter().collect(),
            keys: keys.into_iter().collect(),
            reject: regex_list(&settings.ast_reject_re, DEFAULT_REJECT_PATTERNS),
            valid: regex_list(&settings.ast_valid_re, DEFAULT_VALID_PATTERNS),
            max_length: settings.ast_max_length,
        }
    }
}

fn default_re_flags() -> String {
    "gs".to_string()
}

fn default_translation_version() -> String {
    "1.0.1".to_string()
}

fn default_enabled() -> bool {
    true
}

fn default_max_length() -> usize {
    300
}

fn default_chinese_skip_mode() -> String {
    "source".to_string()
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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RetryCompletedItemKey {
    failure_id: String,
    dict_index: isize,
    file: Option<String>,
    batch_type: String,
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
    checkpoint_path: PathBuf,
    batch_task_record_path: PathBuf,
}

#[derive(Debug, Clone)]
struct DiagnoseCleanupSession {
    paths: PersistencePaths,
    translation_source_id: String,
    translation_json: Value,
    source_by_file: HashMap<String, String>,
    apply_ast: bool,
    apply_regex: bool,
    removed_items: Vec<TranslationIssueItem>,
    pending_candidates: Vec<TranslationCandidate>,
    probe_map: HashMap<String, Vec<TranslationCandidate>>,
    runtime_probe_queue: Vec<Vec<TranslationCandidate>>,
    combo_fallback_groups: Vec<Vec<TranslationCandidate>>,
    pairwise_tested_group_signatures: HashSet<String>,
    processed_files: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    let port = env::args()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(18743);
    let plugin_dir = env::current_dir().context("failed to read current directory")?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let shutdown = Arc::new(Mutex::new(Some(shutdown_tx)));
    watch_stdin_shutdown(shutdown.clone());
    let state = AppState {
        tasks: Arc::new(Mutex::new(HashMap::new())),
        diagnose_sessions: Arc::new(Mutex::new(HashMap::new())),
        persistence_lock: Arc::new(Mutex::new(())),
        plugin_dir,
        http: reqwest::Client::builder()
            .danger_accept_invalid_certs(false)
            .build()?,
        shutdown,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/identity", get(identity_route))
        .route("/resources/plugins", get(discover_plugins_route))
        .route("/resources/themes", get(discover_themes_route))
        .route("/github/read", post(github_read_route))
        .route("/github/write", post(github_write_route))
        .route("/automation/match", post(automation_match_route))
        .route("/proxy", post(proxy_route))
        .route("/task", post(task_route))
        .route("/task/start", post(task_start_route))
        .route("/task/status", get(task_status_route))
        .route("/task/cancel", post(task_cancel_route))
        .route("/shutdown", post(shutdown_route))
        .with_state(state);

    let addr: SocketAddr = format!("{HOST}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("ready {HOST}:{port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await?;
    Ok(())
}

fn watch_stdin_shutdown(shutdown: Arc<Mutex<Option<oneshot::Sender<()>>>>) {
    tokio::spawn(async move {
        let mut stdin = tokio::io::stdin();
        let mut buffer = [0_u8; 1];
        loop {
            match stdin.read(&mut buffer).await {
                Ok(0) | Err(_) => {
                    if let Some(shutdown) = shutdown.lock().await.take() {
                        let _ = shutdown.send(());
                    }
                    break;
                }
                Ok(_) => {}
            }
        }
    });
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

async fn identity_route(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "pid": std::process::id(),
        "pluginDir": state.plugin_dir.to_string_lossy(),
    }))
}

async fn shutdown_route(State(state): State<AppState>) -> impl IntoResponse {
    if let Some(shutdown) = state.shutdown.lock().await.take() {
        let _ = shutdown.send(());
    }
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(100));
        std::process::exit(0);
    });
    Json(json!({ "ok": true }))
}

async fn discover_plugins_route(State(state): State<AppState>) -> impl IntoResponse {
    match discover_plugins(&state).await {
        Ok(plugins) => Json(json!({ "ok": true, "plugins": plugins })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn discover_themes_route(State(state): State<AppState>) -> impl IntoResponse {
    match discover_themes(&state).await {
        Ok(themes) => Json(json!({ "ok": true, "themes": themes })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn github_read_route(
    State(state): State<AppState>,
    Json(payload): Json<GithubReadRequest>,
) -> impl IntoResponse {
    match github_read(&state, payload).await {
        Ok(result) => Json(json!({ "ok": true, "result": result })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn github_write_route(
    State(state): State<AppState>,
    Json(payload): Json<GithubWriteRequest>,
) -> impl IntoResponse {
    match github_write(&state, payload).await {
        Ok(result) => Json(json!({ "ok": true, "result": result })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn automation_match_route(Json(payload): Json<AutomationMatchRequest>) -> impl IntoResponse {
    match select_best_translation(payload) {
        Ok(result) => Json(json!({ "ok": true, "result": result })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

fn obsidian_dir(state: &AppState) -> Result<PathBuf> {
    if state.plugin_dir.file_name().and_then(|name| name.to_str()) == Some("i18n") {
        if let Some(parent) = state.plugin_dir.parent() {
            if parent.file_name().and_then(|name| name.to_str()) == Some("plugins") {
                if let Some(obsidian_dir) = parent.parent() {
                    return Ok(obsidian_dir.to_path_buf());
                }
            }
        }
    }

    let nested = state.plugin_dir.join(".obsidian");
    if nested.exists() {
        return Ok(nested);
    }

    Err(anyhow!("failed to locate .obsidian directory"))
}

async fn discover_plugins(state: &AppState) -> Result<Vec<Value>> {
    let obsidian_dir = obsidian_dir(state)?;
    let plugins_dir = obsidian_dir.join("plugins");
    let current_plugin_id = read_json_file(&state.plugin_dir.join("manifest.json"))
        .and_then(|manifest| manifest.get("id").and_then(Value::as_str).map(str::to_string));
    let mut plugins = Vec::new();

    for entry in fs::read_dir(&plugins_dir).with_context(|| format!("failed to read {}", plugins_dir.display()))? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if !file_type.is_dir() {
            continue;
        }
        let dir = entry.path();
        let manifest_doc = dir.join("manifest.json");
        let main_doc = dir.join("main.js");
        if !manifest_doc.exists() || !main_doc.exists() {
            continue;
        }
        let Some(mut manifest) = read_json_file(&manifest_doc) else {
            continue;
        };
        let id = manifest.get("id").and_then(Value::as_str).unwrap_or_default();
        if current_plugin_id.as_deref() == Some(id) {
            continue;
        }
        if manifest.get("dir").is_none() {
            manifest["dir"] = Value::String(obsidian_relative_path(&dir));
        }
        plugins.push(json!({
            "manifest": manifest,
            "dir": obsidian_relative_path(&dir),
            "mainDoc": main_doc.to_string_lossy(),
            "manifestDoc": manifest_doc.to_string_lossy(),
        }));
    }

    plugins.sort_by(|left, right| {
        left.pointer("/manifest/name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase()
            .cmp(&right.pointer("/manifest/name").and_then(Value::as_str).unwrap_or_default().to_lowercase())
    });
    Ok(plugins)
}

async fn discover_themes(state: &AppState) -> Result<Vec<Value>> {
    let obsidian_dir = obsidian_dir(state)?;
    let themes_dir = obsidian_dir.join("themes");
    if !themes_dir.exists() {
        return Ok(Vec::new());
    }

    let mut themes = Vec::new();
    let mut modern_theme_names = HashSet::new();
    for entry in fs::read_dir(&themes_dir).with_context(|| format!("failed to read {}", themes_dir.display()))? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if !file_type.is_dir() {
            continue;
        }
        let dir = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        modern_theme_names.insert(name.clone());
        let manifest = read_json_file(&dir.join("manifest.json"));
        let theme_css_path = dir.join("theme.css");
        themes.push(json!({
            "name": name,
            "manifest": manifest,
            "dir": dir.to_string_lossy(),
            "themeCssPath": theme_css_path.to_string_lossy(),
            "themeCssRelativePath": "theme.css",
            "isLegacy": false,
        }));
    }

    for entry in fs::read_dir(&themes_dir).with_context(|| format!("failed to read {}", themes_dir.display()))? {
        let entry = entry?;
        if !entry.file_type()?.is_file() || !entry.path().extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("css")) {
            continue;
        }
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        let name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(&file_name)
            .to_string();
        if modern_theme_names.contains(&name) {
            continue;
        }
        themes.push(json!({
            "name": name,
            "manifest": Value::Null,
            "dir": themes_dir.to_string_lossy(),
            "themeCssPath": path.to_string_lossy(),
            "themeCssRelativePath": file_name,
            "isLegacy": true,
        }));
    }

    themes.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase()
            .cmp(&right.get("name").and_then(Value::as_str).unwrap_or_default().to_lowercase())
    });
    Ok(themes)
}

fn read_json_file(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn obsidian_relative_path(path: &Path) -> String {
    path.file_name()
        .map(|name| format!(".obsidian/plugins/{}", name.to_string_lossy()))
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn is_chinese_code_point(code_point: u32) -> bool {
    (0x3400..=0x4dbf).contains(&code_point)
        || (0x4e00..=0x9fff).contains(&code_point)
        || (0xf900..=0xfaff).contains(&code_point)
        || (0x20000..=0x2fa1f).contains(&code_point)
}

fn is_hex_text(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn chinese_unicode_escape_len(text: &str, index: usize) -> usize {
    let bytes = text.as_bytes();
    if bytes.get(index) != Some(&b'\\') || bytes.get(index + 1) != Some(&b'u') {
        return 0;
    }
    if bytes.get(index + 2) == Some(&b'{') {
        let Some(close_offset) = text[index + 3..].find('}') else {
            return 0;
        };
        let close_index = index + 3 + close_offset;
        let hex = &text[index + 3..close_index];
        if (4..=6).contains(&hex.len())
            && is_hex_text(hex)
            && is_chinese_code_point(u32::from_str_radix(hex, 16).unwrap_or(0))
        {
            return close_index - index + 1;
        }
        return 0;
    }
    if index + 6 <= text.len() {
        let hex = &text[index + 2..index + 6];
        if is_hex_text(hex) && is_chinese_code_point(u32::from_str_radix(hex, 16).unwrap_or(0)) {
            return 6;
        }
    }
    0
}

fn count_chinese_unicode_escapes(text: &str, limit: usize) -> usize {
    let mut count = 0;
    let mut index = 0;
    while let Some(offset) = text[index..].find("\\u") {
        let absolute = index + offset;
        let escape_len = chinese_unicode_escape_len(text, absolute);
        if escape_len > 0 {
            count += 1;
            if count >= limit {
                return count;
            }
            index = absolute + escape_len;
        } else {
            index = absolute + 2;
        }
        if index >= text.len() {
            break;
        }
    }
    count
}

fn has_chinese_text(text: &str) -> bool {
    text.chars().any(|ch| is_chinese_code_point(ch as u32)) || count_chinese_unicode_escapes(text, 1) > 0
}

fn has_chinese_run_pattern(
    text: &str,
    min_run_length: usize,
    min_run_count: usize,
    required_run_length: usize,
) -> bool {
    let mut matched_runs = 0;
    let mut has_required_run = false;
    let mut run_length = 0;
    let mut index = 0;

    let flush_run = |run_length: &mut usize, matched_runs: &mut usize, has_required_run: &mut bool| {
        if *run_length >= min_run_length {
            *matched_runs += 1;
        }
        if *run_length >= required_run_length {
            *has_required_run = true;
        }
        *run_length = 0;
    };

    while index < text.len() {
        let escape_len = chinese_unicode_escape_len(text, index);
        if escape_len > 0 {
            run_length += 1;
            index += escape_len;
            continue;
        }
        let Some(ch) = text[index..].chars().next() else {
            break;
        };
        if is_chinese_code_point(ch as u32) {
            run_length += 1;
        } else {
            flush_run(&mut run_length, &mut matched_runs, &mut has_required_run);
            if matched_runs >= min_run_count && has_required_run {
                return true;
            }
        }
        index += ch.len_utf8();
    }
    flush_run(&mut run_length, &mut matched_runs, &mut has_required_run);
    matched_runs >= min_run_count && has_required_run
}

fn chinese_skip_mode(settings: &ExtractionSettings) -> &str {
    match settings.chinese_skip_mode.as_str() {
        "none" => "none",
        "extracted" => "extracted",
        _ => "source",
    }
}

fn is_chinese_skip_mode(settings: &ExtractionSettings, mode: &str) -> bool {
    chinese_skip_mode(settings) == mode
}

fn should_skip_chinese_by_source(metadata_text: &str, source_text: &str) -> bool {
    has_chinese_text(metadata_text) || has_chinese_run_pattern(source_text, 2, 5, 5)
}

fn should_skip_chinese_by_extracted_items(metadata_text: &str, sources: &[String]) -> bool {
    has_chinese_text(metadata_text)
        || sources
            .iter()
            .any(|source| has_chinese_run_pattern(source, 5, 1, 5))
}

fn has_extracted_translation_content(sources: &[String]) -> bool {
    sources.iter().any(|source| !source.trim().is_empty())
}

fn regex_list(patterns: &[String], defaults: &[&str]) -> Vec<Regex> {
    let source = if patterns.is_empty() {
        defaults.iter().map(|item| item.to_string()).collect::<Vec<_>>()
    } else {
        patterns.to_vec()
    };
    source.iter().filter_map(|pattern| Regex::new(pattern).ok()).collect()
}

fn is_valid_text_with_options(
    text: &str,
    max_length: usize,
    reject: &[Regex],
    valid: &[Regex],
    zero_means_unlimited: bool,
    allow_plain_word: bool,
) -> bool {
    if text.is_empty() {
        return false;
    }
    if max_length == 0 {
        if !zero_means_unlimited {
            return false;
        }
    } else if text.chars().count() > max_length {
        return false;
    }
    if reject.iter().any(|pattern| pattern.is_match(text)) {
        return false;
    }
    if valid.is_empty() || valid.iter().any(|pattern| pattern.is_match(text)) {
        return true;
    }
    allow_plain_word && text.chars().all(|ch| ch.is_ascii_alphabetic()) && text.chars().count() >= 2
}

fn is_valid_regex_text(text: &str, max_length: usize, reject: &[Regex], valid: &[Regex]) -> bool {
    is_valid_text_with_options(text, max_length, reject, valid, false, false)
}

fn is_valid_ast_text(text: &str, max_length: usize, reject: &[Regex], valid: &[Regex]) -> bool {
    is_valid_text_with_options(text, max_length, reject, valid, true, true)
}

fn capture_js_string(code: &str, quote_index: usize) -> Option<(String, usize)> {
    let quote = *code.as_bytes().get(quote_index)?;
    if quote != b'\'' && quote != b'"' && quote != b'`' {
        return None;
    }
    let mut escaped = false;
    let mut index = quote_index + 1;
    while index < code.len() {
        let byte = code.as_bytes()[index];
        if escaped {
            escaped = false;
            index += 1;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
            index += 1;
            continue;
        }
        if byte == quote {
            return Some((code[quote_index + 1..index].to_string(), index + 1));
        }
        index += 1;
    }
    None
}

fn unescape_simple_js_string(text: &str) -> String {
    let mut result = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            result.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => result.push('\n'),
            Some('r') => result.push('\r'),
            Some('t') => result.push('\t'),
            Some('b') => result.push('\u{0008}'),
            Some('f') => result.push('\u{000c}'),
            Some('v') => result.push('\u{000b}'),
            Some('0') => result.push('\0'),
            Some('\\') => result.push('\\'),
            Some('\'') => result.push('\''),
            Some('"') => result.push('"'),
            Some('`') => result.push('`'),
            Some('u') => {
                if chars.peek() == Some(&'{') {
                    chars.next();
                    let mut hex = String::new();
                    for next in chars.by_ref() {
                        if next == '}' {
                            break;
                        }
                        hex.push(next);
                    }
                    if let Ok(value) = u32::from_str_radix(&hex, 16) {
                        if let Some(decoded) = char::from_u32(value) {
                            result.push(decoded);
                        }
                    }
                } else {
                    let hex: String = chars.by_ref().take(4).collect();
                    if let Ok(value) = u32::from_str_radix(&hex, 16) {
                        if let Some(decoded) = char::from_u32(value) {
                            result.push(decoded);
                        }
                    }
                }
            }
            Some(other) => result.push(other),
            None => result.push('\\'),
        }
    }
    result
}

fn contains_word(list: &[String], word: &str) -> bool {
    list.iter().any(|item| item == word)
}

fn previous_assignment_name(code: &str, before_index: usize) -> Option<String> {
    let start = code[..before_index].rfind(['\n', ';', '{', '}']).map(|index| index + 1).unwrap_or(0);
    let prefix = &code[start..before_index];
    let patterns = [
        r"\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*$",
        r#"\[\s*["']([^"']+)["']\s*\]\s*=\s*$"#,
    ];
    for pattern in patterns {
        let re = Regex::new(pattern).ok()?;
        if let Some(captures) = re.captures(prefix) {
            if let Some(value) = captures.get(1) {
                return Some(value.as_str().to_string());
            }
        }
    }
    None
}

fn previous_object_key_name(code: &str, before_index: usize) -> Option<String> {
    let start = code[..before_index].rfind(['\n', ',', '{', '(']).map(|index| index + 1).unwrap_or(0);
    let prefix = &code[start..before_index];
    let patterns = [
        r"([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*$",
        r#"["']([^"']+)["']\s*:\s*$"#,
    ];
    for pattern in patterns {
        let re = Regex::new(pattern).ok()?;
        if let Some(captures) = re.captures(prefix) {
            if let Some(value) = captures.get(1) {
                return Some(value.as_str().to_string());
            }
        }
    }
    None
}

fn previous_variable_name(code: &str, before_index: usize) -> Option<String> {
    let start = code[..before_index].rfind(['\n', ';', '{', '}']).map(|index| index + 1).unwrap_or(0);
    let prefix = &code[start..before_index];
    let re = Regex::new(r"(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*$").ok()?;
    re.captures(prefix).and_then(|captures| captures.get(1).map(|m| m.as_str().to_string()))
}

fn call_name_before(code: &str, before_index: usize) -> Option<(String, bool)> {
    let start = code[..before_index].rfind(['\n', ';', '{', '}']).map(|index| index + 1).unwrap_or(0);
    let prefix = &code[start..before_index];
    let re = Regex::new(r"(new\s+)?([A-Za-z_$][A-Za-z0-9_$.]*)\s*\([^()]*$").ok()?;
    re.captures(prefix).and_then(|captures| {
        captures.get(2).map(|m| {
            let name = m
                .as_str()
                .rsplit('.')
                .next()
                .unwrap_or_default()
                .to_string();
            (name, captures.get(1).is_some())
        })
    })
}

fn builtin_regex_extract(code: &str, settings: &ExtractionSettings, reject: &[Regex], valid: &[Regex]) -> Vec<Value> {
    let watched_calls = [
        "Notice", "log", "error", "setText", "setButtonText", "setName", "setDesc", "setPlaceholder",
        "setTooltip", "appendText", "setTitle", "addHeading", "renderMarkdown",
    ];
    let watched_fields = [
        "textContent", "innerText", "name", "description", "selection", "annotation", "link", "text",
        "search", "speech", "page", "settings",
    ];
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    let mut index = 0;
    while index < code.len() {
        let Some(relative) = code[index..].find(['\'', '"', '`']) else {
            break;
        };
        let quote_index = index + relative;
        let Some((raw, end_index)) = capture_js_string(code, quote_index) else {
            index = quote_index + 1;
            continue;
        };
        let source = unescape_simple_js_string(&raw);
        let mut matched_context = false;
        if let Some((name, _)) = call_name_before(code, quote_index) {
            matched_context = watched_calls.contains(&name.as_str());
        }
        if !matched_context {
            if let Some(name) = previous_assignment_name(code, quote_index).or_else(|| previous_object_key_name(code, quote_index)) {
                matched_context = watched_fields.contains(&name.as_str());
            }
        }
        if matched_context
            && is_valid_regex_text(&source, settings.re_length, reject, valid)
            && seen.insert(source.clone())
        {
            items.push(json!({ "source": source, "target": source }));
        }
        index = end_index;
    }
    items
}

fn parse_swc_module(code: &str) -> Result<(Lrc<SourceMap>, Module)> {
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(FileName::Anon.into(), code.to_string());
    let lexer = Lexer::new(
        Syntax::Typescript(TsSyntax {
            tsx: true,
            decorators: true,
            dts: false,
            no_early_errors: true,
            disallow_ambiguous_jsx_like: false,
        }),
        EsVersion::Es2022,
        StringInput::from(&*fm),
        None,
    );
    let mut parser = Parser::new_from(lexer);
    parser
        .parse_module()
        .map_err(|error| anyhow!("SWC AST Parse Error: {error:?}"))
        .map(|module| (cm, module))
}

fn swc_atom_text(value: &swc_atoms::Wtf8Atom) -> String {
    value.to_string_lossy().to_string()
}

fn swc_string_source(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Lit(Lit::Str(value)) => Some(swc_atom_text(&value.value)),
        Expr::Tpl(tpl) if tpl.exprs.is_empty() && tpl.quasis.len() == 1 => {
            tpl.quasis.first().map(|item| item.raw.to_string())
        }
        _ => None,
    }
}

fn swc_prop_name(prop: &PropName) -> Option<String> {
    match prop {
        PropName::Ident(ident) => Some(ident.sym.to_string()),
        PropName::Str(value) => Some(swc_atom_text(&value.value)),
        PropName::Num(value) => Some(value.value.to_string()),
        _ => None,
    }
}

fn swc_member_prop_name(prop: &MemberProp) -> Option<String> {
    match prop {
        MemberProp::Ident(ident) => Some(ident.sym.to_string()),
        MemberProp::Computed(computed) => match &*computed.expr {
            Expr::Lit(Lit::Str(value)) => Some(swc_atom_text(&value.value)),
            _ => None,
        },
        MemberProp::PrivateName(private_name) => Some(private_name.name.to_string()),
    }
}

fn swc_assign_name(target: &AssignTarget) -> Option<String> {
    match target {
        AssignTarget::Simple(simple) => match simple {
            SimpleAssignTarget::Ident(binding) => Some(binding.id.sym.to_string()),
            SimpleAssignTarget::Member(member) => swc_member_prop_name(&member.prop),
            _ => None,
        },
        _ => None,
    }
}

fn swc_callee_name(callee: &Callee) -> Option<String> {
    match callee {
        Callee::Expr(expr) => swc_expr_name(expr),
        Callee::Super(_) => Some("super".to_string()),
        Callee::Import(_) => Some("import".to_string()),
    }
}

fn swc_expr_name(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Ident(ident) => Some(ident.sym.to_string()),
        Expr::Member(member) => swc_member_prop_name(&member.prop),
        Expr::OptChain(chain) => match &*chain.base {
            OptChainBase::Member(member) => swc_member_prop_name(&member.prop),
            OptChainBase::Call(call) => swc_expr_name(&call.callee),
        },
        _ => None,
    }
}

fn push_swc_match(matches: &mut Vec<AstMatch>, config: &SwcAstConfig, node_type: &str, name: &str, expr: &Expr) {
    let Some(source) = swc_string_source(expr) else {
        return;
    };
    if is_valid_ast_text(&source, config.max_length, &config.reject, &config.valid) {
        matches.push(AstMatch {
            node_type: node_type.to_string(),
            name: name.to_string(),
            source,
        });
    }
}

fn visit_object_arg_properties(matches: &mut Vec<AstMatch>, config: &SwcAstConfig, object: &ObjectLit) {
    for prop in &object.props {
        if let PropOrSpread::Prop(prop) = prop {
            if let Prop::KeyValue(key_value) = &**prop {
                if let Some(name) = swc_prop_name(&key_value.key) {
                    if let Expr::Lit(_) | Expr::Tpl(_) = &*key_value.value {
                        push_swc_match(matches, config, "ObjectProperty", &name, &key_value.value);
                    }
                }
            }
        }
    }
}

struct SwcExtractVisitor<'a> {
    config: &'a SwcAstConfig,
    matches: Vec<AstMatch>,
}

impl Visit for SwcExtractVisitor<'_> {
    fn visit_var_declarator(&mut self, node: &VarDeclarator) {
        if let Pat::Ident(ident) = &node.name {
            let name = ident.id.sym.to_string();
            if self.config.assignments.contains(&name) {
                if let Some(init) = node.init.as_deref() {
                    push_swc_match(&mut self.matches, self.config, "VariableDeclarator", &name, init);
                }
            }
        }
        node.visit_children_with(self);
    }

    fn visit_assign_expr(&mut self, node: &AssignExpr) {
        if let Some(name) = swc_assign_name(&node.left) {
            if self.config.assignments.contains(&name) {
                push_swc_match(&mut self.matches, self.config, "AssignmentExpression", &name, &node.right);
            }
        }
        node.visit_children_with(self);
    }

    fn visit_prop(&mut self, node: &Prop) {
        if let Prop::KeyValue(key_value) = node {
            if let Some(name) = swc_prop_name(&key_value.key) {
                if self.config.keys.contains(&name) {
                    push_swc_match(&mut self.matches, self.config, "ObjectProperty", &name, &key_value.value);
                }
            }
        }
        node.visit_children_with(self);
    }

    fn visit_call_expr(&mut self, node: &CallExpr) {
        if let Some(name) = swc_callee_name(&node.callee) {
            if self.config.functions.contains(&name) {
                for arg in &node.args {
                    match &*arg.expr {
                        Expr::Object(object) => visit_object_arg_properties(&mut self.matches, self.config, object),
                        expr => push_swc_match(&mut self.matches, self.config, "CallExpression", &name, expr),
                    }
                }
            }
        }
        node.visit_children_with(self);
    }

    fn visit_new_expr(&mut self, node: &NewExpr) {
        if let Some(name) = swc_expr_name(&node.callee) {
            if self.config.functions.contains(&name) {
                for arg in node.args.iter().flatten() {
                    match &*arg.expr {
                        Expr::Object(object) => visit_object_arg_properties(&mut self.matches, self.config, object),
                        expr => push_swc_match(&mut self.matches, self.config, "NewExpression", &name, expr),
                    }
                }
            }
        }
        node.visit_children_with(self);
    }
}

fn extract_ast_items_swc(code: &str, settings: &ExtractionSettings) -> Result<Vec<Value>> {
    let (_, module) = parse_swc_module(code)?;
    let config = SwcAstConfig::from_settings(settings);
    let mut visitor = SwcExtractVisitor { config: &config, matches: Vec::new() };
    module.visit_with(&mut visitor);
    let mut seen = HashSet::new();
    let mut matches = visitor
        .matches
        .into_iter()
        .filter_map(|item| {
            let key = format!("{}:{}:{}", item.node_type, item.name, item.source);
            if seen.insert(key) {
                Some(json!({
                    "type": item.node_type,
                    "name": item.name,
                    "source": item.source,
                    "target": item.source,
                }))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        let left_key = format!("{}:{}", left.get("type").and_then(Value::as_str).unwrap_or_default(), left.get("name").and_then(Value::as_str).unwrap_or_default());
        let right_key = format!("{}:{}", right.get("type").and_then(Value::as_str).unwrap_or_default(), right.get("name").and_then(Value::as_str).unwrap_or_default());
        left_key.cmp(&right_key)
    });
    Ok(matches)
}

fn extract_ast_items_heuristic(code: &str, settings: &ExtractionSettings) -> Vec<Value> {
    let assignments = if settings.ast_assignments.is_empty() {
        vec!["overwriteName", "innerHTML", "outerHTML", "title", "alt", "placeholder", "textContent", "innerText", "ariaLabel", "nodeValue", "buttonText", "confirmText", "cancelText", "labelText"]
            .into_iter().map(str::to_string).collect()
    } else {
        settings.ast_assignments.clone()
    };
    let functions = if settings.ast_functions.is_empty() {
        vec!["Notice", "setTitle", "setContent", "setName", "setDesc", "setButtonText", "setPlaceholder", "setTooltip", "addOption", "addOptions", "addHeading", "addText", "setHint", "setWarning", "setText", "appendText", "createEl", "createDiv", "createSpan", "addCommand", "insertText", "replaceRange", "replaceSelection", "log", "error", "warn", "info", "alert", "confirm", "prompt", "renderMarkdown", "setLabel", "setConfirmText", "setCancelText"]
            .into_iter().map(str::to_string).collect()
    } else {
        settings.ast_functions.clone()
    };
    let keys = if settings.ast_keys.is_empty() {
        vec!["name", "description", "text", "placeholder", "label", "tooltip", "title", "header", "desc", "message", "buttontext", "aria-label", "heading", "content", "tab", "caption", "subtitle", "summary", "info", "warning", "error", "success", "hint", "instructions", "link", "selection", "annotation", "search", "speech", "page", "empty", "detail", "body", "option", "notice", "confirmText", "cancelText", "ariaLabel", "buttonText"]
            .into_iter().map(str::to_string).collect()
    } else {
        settings.ast_keys.clone()
    };
    let reject = regex_list(&settings.ast_reject_re, DEFAULT_REJECT_PATTERNS);
    let valid = regex_list(&settings.ast_valid_re, DEFAULT_VALID_PATTERNS);
    let mut seen = HashSet::new();
    let mut matches = Vec::new();
    let mut index = 0;

    while index < code.len() {
        let Some(relative) = code[index..].find(['\'', '"', '`']) else {
            break;
        };
        let quote_index = index + relative;
        let Some((raw, end_index)) = capture_js_string(code, quote_index) else {
            index = quote_index + 1;
            continue;
        };
        if raw.contains("${") {
            index = end_index;
            continue;
        }
        let source = unescape_simple_js_string(&raw);
        let mut ast_match: Option<AstMatch> = None;

        if let Some(name) = previous_assignment_name(code, quote_index) {
            if contains_word(&assignments, &name) {
                ast_match = Some(AstMatch { node_type: "AssignmentExpression".to_string(), name, source: source.clone() });
            }
        }
        if ast_match.is_none() {
            if let Some(name) = previous_object_key_name(code, quote_index) {
                if contains_word(&keys, &name) {
                    ast_match = Some(AstMatch { node_type: "ObjectProperty".to_string(), name, source: source.clone() });
                }
            }
        }
        if ast_match.is_none() {
            if let Some(name) = previous_variable_name(code, quote_index) {
                if contains_word(&assignments, &name) {
                    ast_match = Some(AstMatch { node_type: "VariableDeclarator".to_string(), name, source: source.clone() });
                }
            }
        }
        if ast_match.is_none() {
            if let Some((name, is_new)) = call_name_before(code, quote_index) {
                if contains_word(&functions, &name) {
                    ast_match = Some(AstMatch { node_type: if is_new { "NewExpression" } else { "CallExpression" }.to_string(), name, source: source.clone() });
                }
            }
        }
        if let Some(item) = ast_match {
            if is_valid_ast_text(&item.source, settings.ast_max_length, &reject, &valid) {
                let key = format!("{}:{}:{}", item.node_type, item.name, item.source);
                if seen.insert(key) {
                    matches.push(json!({
                        "type": item.node_type,
                        "name": item.name,
                        "source": item.source,
                        "target": item.source,
                    }));
                }
            }
        }
        index = end_index;
    }
    matches.sort_by(|left, right| {
        let left_key = format!("{}:{}", left.get("type").and_then(Value::as_str).unwrap_or_default(), left.get("name").and_then(Value::as_str).unwrap_or_default());
        let right_key = format!("{}:{}", right.get("type").and_then(Value::as_str).unwrap_or_default(), right.get("name").and_then(Value::as_str).unwrap_or_default());
        left_key.cmp(&right_key)
    });
    matches
}

fn extract_ast_items(code: &str, settings: &ExtractionSettings) -> Vec<Value> {
    if !settings.ast_extraction_enabled {
        return Vec::new();
    }
    match extract_ast_items_swc(code, settings) {
        Ok(items) => items,
        Err(error) => {
            eprintln!("[i18n] SWC AST extraction fallback: {error}");
            extract_ast_items_heuristic(code, settings)
        }
    }
}

fn swc_set_expr_string(expr: &mut Expr, target: &str) {
    match expr {
        Expr::Lit(Lit::Str(value)) => {
            value.value = target.into();
            value.raw = None;
        }
        Expr::Tpl(tpl) if tpl.exprs.is_empty() && tpl.quasis.len() == 1 => {
            if let Some(first) = tpl.quasis.first_mut() {
                first.raw = target.into();
                first.cooked = Some(target.into());
            }
        }
        _ => {}
    }
}

fn lookup_ast_replacement(strict: &HashMap<String, String>, loose: &HashMap<String, String>, node_type: &str, name: &str, expr: &Expr) -> Option<String> {
    let source = swc_string_source(expr)?;
    strict
        .get(&format!("{node_type}:{name}:{source}"))
        .or_else(|| loose.get(&source))
        .filter(|target| *target != &source)
        .cloned()
}

fn replace_expr_if_matches(strict: &HashMap<String, String>, loose: &HashMap<String, String>, node_type: &str, name: &str, expr: &mut Box<Expr>) {
    if let Some(target) = lookup_ast_replacement(strict, loose, node_type, name, expr) {
        swc_set_expr_string(expr, &target);
    }
}

fn replace_object_arg_properties(strict: &HashMap<String, String>, loose: &HashMap<String, String>, object: &mut ObjectLit) {
    for prop in &mut object.props {
        if let PropOrSpread::Prop(prop) = prop {
            if let Prop::KeyValue(key_value) = &mut **prop {
                let name = swc_prop_name(&key_value.key).unwrap_or_else(|| "prop".to_string());
                replace_expr_if_matches(strict, loose, "ObjectProperty", &name, &mut key_value.value);
            }
        }
    }
}

struct SwcReplaceVisitor<'a> {
    strict: &'a HashMap<String, String>,
    loose: &'a HashMap<String, String>,
}

impl VisitMut for SwcReplaceVisitor<'_> {
    fn visit_mut_var_declarator(&mut self, node: &mut VarDeclarator) {
        if let Pat::Ident(ident) = &node.name {
            if let Some(init) = node.init.as_mut() {
                replace_expr_if_matches(self.strict, self.loose, "VariableDeclarator", &ident.id.sym.to_string(), init);
            }
        }
        node.visit_mut_children_with(self);
    }

    fn visit_mut_assign_expr(&mut self, node: &mut AssignExpr) {
        if let Some(name) = swc_assign_name(&node.left) {
            replace_expr_if_matches(self.strict, self.loose, "AssignmentExpression", &name, &mut node.right);
        }
        node.visit_mut_children_with(self);
    }

    fn visit_mut_prop(&mut self, node: &mut Prop) {
        if let Prop::KeyValue(key_value) = node {
            let name = swc_prop_name(&key_value.key).unwrap_or_else(|| "prop".to_string());
            replace_expr_if_matches(self.strict, self.loose, "ObjectProperty", &name, &mut key_value.value);
        }
        node.visit_mut_children_with(self);
    }

    fn visit_mut_call_expr(&mut self, node: &mut CallExpr) {
        let name = swc_callee_name(&node.callee).unwrap_or_else(|| "func".to_string());
        for arg in &mut node.args {
            match &mut *arg.expr {
                Expr::Object(object) => replace_object_arg_properties(self.strict, self.loose, object),
                _ => replace_expr_if_matches(self.strict, self.loose, "CallExpression", &name, &mut arg.expr),
            }
        }
        node.visit_mut_children_with(self);
    }

    fn visit_mut_new_expr(&mut self, node: &mut NewExpr) {
        let name = swc_expr_name(&node.callee).unwrap_or_else(|| "new".to_string());
        for arg in node.args.iter_mut().flatten() {
            match &mut *arg.expr {
                Expr::Object(object) => replace_object_arg_properties(self.strict, self.loose, object),
                _ => replace_expr_if_matches(self.strict, self.loose, "NewExpression", &name, &mut arg.expr),
            }
        }
        node.visit_mut_children_with(self);
    }
}

fn replace_ast_items_swc(code: &str, translations: &[Value]) -> Result<String> {
    let (cm, mut module) = parse_swc_module(code)?;
    let mut strict = HashMap::new();
    let mut loose = HashMap::new();
    for item in translations {
        let source = item.get("source").and_then(Value::as_str).unwrap_or_default();
        let target = item.get("target").and_then(Value::as_str).unwrap_or_default();
        if source.is_empty() || target.is_empty() || source == target {
            continue;
        }
        if let (Some(node_type), Some(name)) = (item.get("type").and_then(Value::as_str), item.get("name").and_then(Value::as_str)) {
            strict.insert(format!("{node_type}:{name}:{source}"), target.to_string());
        }
        loose.insert(source.to_string(), target.to_string());
    }
    module.visit_mut_with(&mut SwcReplaceVisitor { strict: &strict, loose: &loose });

    let mut output = Vec::new();
    {
        let writer = JsWriter::new(cm.clone(), "\n", &mut output, None);
        let mut emitter = Emitter {
            cfg: swc_ecma_codegen::Config::default().with_minify(true),
            comments: None,
            cm,
            wr: Box::new(writer),
        };
        emitter.emit_module(&module)?;
    }
    Ok(String::from_utf8(output)?)
}

fn is_default_regex_patterns(patterns: &[String]) -> bool {
    patterns.len() == 2
        && patterns[0] == "(Notice|log|error|setText|setButtonText|setName|setDesc|setPlaceholder|setTooltip|appendText|setTitle|addHeading|renderMarkdown)\\(\\s*(['\"`])((?:[^\\\\2\\\\\\\\]|\\\\\\\\.)*?)\\2\\s*\\)"
        && patterns[1] == "(textContent|innerText|name|description|selection|annotation|link|text|search|speech|page|settings)\\s*[:=]\\s*(['\"`])((?:[^\\\\2\\\\\\\\]|\\\\\\\\.)*?)\\2"
}

fn extract_regex_items(code: &str, settings: &ExtractionSettings) -> Vec<Value> {
    if !settings.re_extraction_enabled {
        return Vec::new();
    }
    let patterns = if settings.re_datas.is_empty() {
        DEFAULT_REGEX_PATTERNS.iter().map(|item| item.to_string()).collect::<Vec<_>>()
    } else {
        settings.re_datas.clone()
    };
    let flags = settings.re_flags.to_lowercase();
    let reject = regex_list(&settings.re_reject_re, DEFAULT_REJECT_PATTERNS);
    let valid = regex_list(&settings.re_valid_re, DEFAULT_VALID_PATTERNS);
    let mut seen = HashSet::new();
    let mut items = Vec::new();

    if settings.re_datas.is_empty() || is_default_regex_patterns(&settings.re_datas) {
        return builtin_regex_extract(code, settings, &reject, &valid);
    }

    for pattern in patterns {
        let mut compiled = String::new();
        if flags.contains('i') {
            compiled.push_str("(?i)");
        }
        compiled.push_str(&pattern);
        let Ok(regex) = Regex::new(&compiled) else {
            continue;
        };
        for captures in regex.captures_iter(code) {
            let Some(source) = captures
                .iter()
                .skip(1)
                .flatten()
                .last()
                .or_else(|| captures.get(0))
                .map(|matched| matched.as_str())
            else {
                continue;
            };
            let source = unescape_simple_js_string(source);
            if !is_valid_regex_text(&source, settings.re_length, &reject, &valid) || seen.contains(&source) {
                continue;
            }
            seen.insert(source.clone());
            items.push(json!({ "source": source, "target": source }));
        }
    }
    items
}

fn extract_theme_items(theme_css: &str) -> Vec<Value> {
    let block_re = Regex::new(r"(?s)/\* @settings(.*?)\*/").unwrap();
    let field_re = Regex::new(r#"(?m)^[ \t]*(name|title|description|label|markdown):\s*(?:['"]([^'"\r\n]*)['"]|([^\r\n]*?))[ \t]*(?:\r?\n|$)"#).unwrap();
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for block in block_re.captures_iter(theme_css) {
        let Some(content) = block.get(1).map(|m| m.as_str()) else {
            continue;
        };
        for field in field_re.captures_iter(content) {
            let field_type = field.get(1).map(|m| m.as_str()).unwrap_or_default();
            let source = field.get(2).or_else(|| field.get(3)).map(|m| m.as_str()).unwrap_or_default();
            if source.trim().is_empty() || !seen.insert(source.to_string()) {
                continue;
            }
            items.push(json!({ "type": field_type, "source": source, "target": source }));
        }
    }
    items
}

const DEFAULT_REJECT_PATTERNS: &[&str] = &[
    r"^\s*$",
    r"^\d+$",
    r"^[\w-]+\.[\w-]+\.\w+$",
    r"^https?://",
    r"^data:image/",
    r"^#([0-9a-f]{3}|[0-9a-f]{6})$",
    r"^[a-z0-9]+-[a-z0-9-]+$",
    r"^[a-z]+[A-Z][a-zA-Z0-9]*$",
    r"^[A-Z_][A-Z0-9_]{3,}$",
    r"^(px|em|rem|vh|vw|auto)$",
    r"^rgba?\(",
    r"^\.",
    r"\.(png|jpg|gif|svg|css|js|ts|md|json)$",
    r"^[\w./\\-]+/[\w./\\-]+$",
];

const DEFAULT_VALID_PATTERNS: &[&str] = &[
    r"\s",
    r"[^\x00-\x7F]",
    r"[!?,;:。！？，；：]\s*$",
];

const DEFAULT_REGEX_PATTERNS: &[&str] = &[
    r#"(Notice|log|error|setText|setButtonText|setName|setDesc|setPlaceholder|setTooltip|appendText|setTitle|addHeading|renderMarkdown)\(\s*(['"`])((?:[^\\]|\\.)*?)\2\s*\)"#,
    r#"(textContent|innerText|name|description|selection|annotation|link|text|search|speech|page|settings)\s*[:=]\s*(['"`])((?:[^\\]|\\.)*?)\2"#,
];

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
            request_task_cancel(&task).await;
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
    let is_cloud = task_type.starts_with("cloud");
    let is_extract = task_type.ends_with("extract");
    let is_retry = task_type.ends_with("retry");
    let resources = if is_retry {
        Vec::new()
    } else {
        payload
            .get("resources")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let total_items = if is_retry {
        payload
            .get("totalItems")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize
    } else {
        payload
            .get("totalItems")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize
    };

    CompanionTaskProgress {
        task_id,
        scope: if is_cloud { "cloud" } else if is_theme { "theme" } else { "plugin" }.to_string(),
        mode: if is_cloud { "backup" } else if is_extract { "extract" } else { "translate" }.to_string(),
        status: "queued".to_string(),
        current_label: String::new(),
        processed_resources: payload
            .get("completedResources")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        total_resources: payload
            .get("totalResources")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(resources.len()),
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
    let progress_snapshot = task.progress.lock().await.clone();
    touch_progress(
        &task,
        json!({
            "status": "running",
            "processedResources": payload.get("completedResources").and_then(Value::as_u64).unwrap_or(progress_snapshot.processed_resources as u64),
            "totalResources": payload.get("totalResources").and_then(Value::as_u64).unwrap_or(progress_snapshot.total_resources as u64),
            "processedItems": payload.get("processedItems").and_then(Value::as_u64).unwrap_or(progress_snapshot.processed_items as u64),
            "totalItems": payload.get("totalItems").and_then(Value::as_u64).unwrap_or(progress_snapshot.total_items as u64),
        }),
    )
    .await;
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
        "cloud-backup-all" => handle_cloud_backup_all(&state, task.clone(), payload).await,
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

async fn request_task_cancel(task: &TaskRuntime) {
    *task.cancel_requested.lock().await = true;
    touch_progress(task, json!({ "currentLabel": "正在停止" })).await;
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
                "totalResources" => {
                    progress.total_resources =
                        value.as_u64().unwrap_or(progress.total_resources as u64) as usize
                }
                "totalItems" => {
                    progress.total_items =
                        value.as_u64().unwrap_or(progress.total_items as u64) as usize
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

async fn github_read(state: &AppState, payload: GithubReadRequest) -> Result<GithubReadResponse> {
    match payload.operation.as_str() {
        "getUser" => github_get_user(state, &payload).await,
        "checkRepoExists" => github_get_json(state, &payload, github_repo_url(&required(&payload.username, "username")?, &required(&payload.repo_name, "repoName")?)).await,
        "getRepoInfo" => github_get_json(state, &payload, github_repo_url(&required(&payload.owner, "owner")?, &required(&payload.repo, "repo")?)).await,
        "getLatestRelease" => github_get_json(state, &payload, format!("{}/releases/latest", github_repo_url(&required(&payload.owner, "owner")?, &required(&payload.repo, "repo")?))).await,
        "getFileContent" => github_get_file_content(state, &payload).await,
        "getFileContentWithFallback" => github_get_file_content_with_fallback(state, &payload).await,
        "getRawContent" => github_get_raw_content(state, &payload).await,
        "downloadAsset" => github_download_asset(state, &payload).await,
        "checkHasOpenRegistrationIssue" => github_check_open_registration_issue(state, &payload).await,
        "getFileCommits" => github_get_file_commits(state, &payload).await,
        "getFileAtCommit" => github_get_file_at_commit(state, &payload).await,
        "getRepoTree" => github_get_repo_tree(state, &payload).await,
        "getRef" => github_get_ref(state, &payload).await,
        _ => bail!("未知 GitHub 读取操作: {}", payload.operation),
    }
}

async fn github_write(state: &AppState, payload: GithubWriteRequest) -> Result<GithubWriteResponse> {
    match payload.operation.as_str() {
        "createRepo" => github_create_repo(state, &payload).await,
        "initRepoStructure" => github_init_repo_structure(state, &payload).await,
        "uploadFile" => github_upload_file(state, &payload).await,
        "deleteFile" => github_delete_file(state, &payload).await,
        "postIssue" => github_post_issue(state, &payload).await,
        "createTree" => github_create_tree(state, &payload).await,
        "createCommit" => github_create_commit(state, &payload).await,
        "updateRef" => github_update_ref(state, &payload).await,
        "batchUploadFiles" => github_batch_upload_files(state, &payload).await,
        _ => bail!("未知 GitHub 写入操作: {}", payload.operation),
    }
}

async fn github_create_repo(state: &AppState, payload: &GithubWriteRequest) -> Result<GithubWriteResponse> {
    if token_missing(&payload.token) {
        return Ok(github_failure("GitHub Token 缺失"));
    }
    let name = required(&payload.name, "name")?;
    github_write_json_request(
        state,
        payload,
        "POST",
        "https://api.github.com/user/repos".to_string(),
        json!({
            "name": name,
            "description": "My Obsidian plugin translations (created by obsidian-i18n)",
            "private": false,
            "auto_init": true,
        }),
    )
    .await
}

async fn github_init_repo_structure(state: &AppState, payload: &GithubWriteRequest) -> Result<GithubWriteResponse> {
    if token_missing(&payload.token) {
        return Ok(github_failure("GitHub Token 缺失"));
    }
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let check_url = format!("{}/contents/metadata.json?t={}", github_repo_url(&owner, &repo), now_ms());
    let check_response = github_write_get_response(state, payload, check_url).await?;
    if check_response.status().as_u16() < 400 {
        return Ok(success_with_status(Value::String("already initialized".to_string()), Some(check_response.status().as_u16())));
    }

    let mut upload_payload = payload.clone();
    upload_payload.path = Some("metadata.json".to_string());
    upload_payload.content = Some(BASE64_STANDARD.encode("[]"));
    upload_payload.message = Some("Initialize metadata.json".to_string());
    upload_payload.branch = Some(payload.branch.clone().unwrap_or_else(|| "main".to_string()));
    github_upload_file(state, &upload_payload).await
}

async fn github_upload_file(state: &AppState, payload: &GithubWriteRequest) -> Result<GithubWriteResponse> {
    if token_missing(&payload.token) {
        return Ok(github_failure("GitHub Token 缺失"));
    }
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let path = required(&payload.path, "path")?;
    let content = required(&payload.content, "content")?;
    let message = required(&payload.message, "message")?;
    let branch = payload.branch.as_deref().unwrap_or("main");
    let mut sha = payload.sha.clone().unwrap_or_default();

    if sha.is_empty() {
        let check_url = format!("{}/contents/{path}?ref={branch}&t={}", github_repo_url(&owner, &repo), now_ms());
        if let Ok(check_response) = github_write_get_response(state, payload, check_url).await {
            if check_response.status().as_u16() == 200 {
                if let Ok(data) = response_body_value(check_response).await {
                    sha = data.get("sha").and_then(Value::as_str).unwrap_or_default().to_string();
                }
            }
        }
    }

    let mut body = json!({
        "message": message,
        "content": content,
        "branch": branch,
    });
    if !sha.is_empty() {
        body["sha"] = Value::String(sha);
    }

    github_write_json_request(
        state,
        payload,
        "PUT",
        format!("{}/contents/{path}", github_repo_url(&owner, &repo)),
        body,
    )
    .await
}

async fn github_delete_file(state: &AppState, payload: &GithubWriteRequest) -> Result<GithubWriteResponse> {
    if token_missing(&payload.token) {
        return Ok(github_failure("GitHub Token 缺失"));
    }
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let path = required(&payload.path, "path")?;
    let message = required(&payload.message, "message")?;
    let branch = payload.branch.as_deref().unwrap_or("main");
    let check_url = format!("{}/contents/{path}?ref={branch}&t={}", github_repo_url(&owner, &repo), now_ms());
    let check_response = github_write_get_response(state, payload, check_url).await?;
    if check_response.status().as_u16() != 200 {
        return Ok(github_failure("GitHub 文件不存在"));
    }
    let data = response_body_value(check_response).await?;
    let sha = data.get("sha").and_then(Value::as_str).unwrap_or_default();
    if sha.is_empty() {
        return Ok(github_failure("获取文件 SHA 失败"));
    }

    github_write_json_request(
        state,
        payload,
        "DELETE",
        format!("{}/contents/{path}", github_repo_url(&owner, &repo)),
        json!({
            "message": message,
            "sha": sha,
            "branch": branch,
        }),
    )
    .await
}

async fn github_post_issue(state: &AppState, payload: &GithubWriteRequest) -> Result<GithubWriteResponse> {
    if token_missing(&payload.token) {
        return Ok(github_failure("GitHub Token 缺失"));
    }
    let owner = payload.target_owner.as_deref().unwrap_or("eondrcode");
    let repo = payload.target_repo.as_deref().unwrap_or("obsidian-i18n-resources");
    let title = required(&payload.title, "title")?;
    let body = required(&payload.body, "body")?;
    let labels = payload
        .label
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|label| vec![label])
        .unwrap_or_default();

    github_write_json_request(
        state,
        payload,
        "POST",
        format!("{}/issues", github_repo_url(owner, repo)),
        json!({
            "title": title,
            "body": body,
            "labels": labels,
        }),
    )
    .await
}

async fn github_create_tree(state: &AppState, payload: &GithubWriteRequest) -> Result<GithubWriteResponse> {
    if token_missing(&payload.token) {
        return Ok(github_failure("GitHub Token 缺失"));
    }
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let base_tree = required(&payload.base_tree, "baseTree")?;
    let tree = payload.tree_data.clone().unwrap_or_default();

    github_write_json_request(
        state,
        payload,
        "POST",
        format!("{}/git/trees", github_repo_url(&owner, &repo)),
        json!({
            "base_tree": base_tree,
            "tree": tree,
        }),
    )
    .await
}

async fn github_create_commit(state: &AppState, payload: &GithubWriteRequest) -> Result<GithubWriteResponse> {
    if token_missing(&payload.token) {
        return Ok(github_failure("GitHub Token 缺失"));
    }
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let message = required(&payload.message, "message")?;
    let commit_tree = required(&payload.tree, "tree")?;
    let parents = payload.parents.clone().unwrap_or_default();

    github_write_json_request(
        state,
        payload,
        "POST",
        format!("{}/git/commits", github_repo_url(&owner, &repo)),
        json!({
            "message": message,
            "tree": commit_tree,
            "parents": parents,
        }),
    )
    .await
}

async fn github_update_ref(state: &AppState, payload: &GithubWriteRequest) -> Result<GithubWriteResponse> {
    if token_missing(&payload.token) {
        return Ok(github_failure("GitHub Token 缺失"));
    }
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let reference = required(&payload.r#ref, "ref")?;
    let sha = required(&payload.sha, "sha")?;

    github_write_json_request(
        state,
        payload,
        "PATCH",
        format!("{}/git/refs/{reference}", github_repo_url(&owner, &repo)),
        json!({
            "sha": sha,
            "force": false,
        }),
    )
    .await
}

async fn github_batch_upload_files(state: &AppState, payload: &GithubWriteRequest) -> Result<GithubWriteResponse> {
    if token_missing(&payload.token) {
        return Ok(github_failure("GitHub Token 缺失"));
    }
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let files = payload.files.clone().unwrap_or_default();
    if files.is_empty() {
        return Ok(success_with_status(Value::String("no files to upload".to_string()), None));
    }
    let message = required(&payload.message, "message")?;
    let branch = payload.branch.as_deref().unwrap_or("main");

    let ref_res = github_write_get_json(state, payload, format!("{}/git/refs/heads/{branch}?t={}", github_repo_url(&owner, &repo), now_ms())).await?;
    if !ref_res.state {
        return Ok(github_failure(format!("获取分支信息失败: {}", ref_res.data)));
    }
    let last_commit_sha = ref_res
        .data
        .pointer("/object/sha")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("分支信息缺少 commit sha"))?
        .to_string();

    let commit_detail = github_write_get_json(
        state,
        payload,
        format!("{}/git/commits/{last_commit_sha}", github_repo_url(&owner, &repo)),
    )
    .await?;
    if !commit_detail.state {
        return Ok(github_failure(format!("获取提交信息失败: {}", commit_detail.data)));
    }
    let base_tree_sha = commit_detail
        .data
        .pointer("/tree/sha")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("提交信息缺少 tree sha"))?
        .to_string();

    let tree_items = files
        .iter()
        .map(|file| json!({
            "path": file.path,
            "mode": "100644",
            "type": "blob",
            "content": file.content,
        }))
        .collect::<Vec<_>>();
    let new_tree = github_write_json_request(
        state,
        payload,
        "POST",
        format!("{}/git/trees", github_repo_url(&owner, &repo)),
        json!({
            "base_tree": base_tree_sha,
            "tree": tree_items,
        }),
    )
    .await?;
    if !new_tree.state {
        return Ok(github_failure(format!("创建 Tree 失败: {}", new_tree.data)));
    }
    let new_tree_sha = new_tree
        .data
        .get("sha")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("新 tree 缺少 sha"))?
        .to_string();

    let new_commit = github_write_json_request(
        state,
        payload,
        "POST",
        format!("{}/git/commits", github_repo_url(&owner, &repo)),
        json!({
            "message": message,
            "tree": new_tree_sha,
            "parents": [last_commit_sha],
        }),
    )
    .await?;
    if !new_commit.state {
        return Ok(github_failure(format!("创建 Commit 失败: {}", new_commit.data)));
    }
    let new_commit_sha = new_commit
        .data
        .get("sha")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("新 commit 缺少 sha"))?
        .to_string();

    let update_ref = github_write_json_request(
        state,
        payload,
        "PATCH",
        format!("{}/git/refs/heads/{branch}", github_repo_url(&owner, &repo)),
        json!({
            "sha": new_commit_sha,
            "force": false,
        }),
    )
    .await?;
    if !update_ref.state {
        return Ok(github_failure(format!("更新引用失败: {}", update_ref.data)));
    }

    Ok(update_ref)
}

async fn github_write_get_json(state: &AppState, payload: &GithubWriteRequest, url: String) -> Result<GithubWriteResponse> {
    let response = github_write_get_response(state, payload, url).await?;
    github_response_from_response(response, None).await
}

async fn github_write_get_response(
    state: &AppState,
    payload: &GithubWriteRequest,
    url: String,
) -> Result<reqwest::Response> {
    let mut request = state
        .http
        .get(url)
        .timeout(Duration::from_millis(payload.timeout_ms.unwrap_or(10_000).max(1000)))
        .header("accept", "application/vnd.github.v3+json")
        .header("user-agent", "obsidian-i18n-companion");
    if let Some(token) = payload.token.as_deref().filter(|token| !token.is_empty()) {
        request = request.header("authorization", format!("token {token}"));
    }
    Ok(request.send().await?)
}

async fn github_write_json_request(
    state: &AppState,
    payload: &GithubWriteRequest,
    method: &str,
    url: String,
    body: Value,
) -> Result<GithubWriteResponse> {
    let mut request = state
        .http
        .request(method.parse()?, url)
        .timeout(Duration::from_millis(payload.timeout_ms.unwrap_or(10_000).max(1000)))
        .header("accept", "application/vnd.github.v3+json")
        .header("content-type", "application/json")
        .header("user-agent", "obsidian-i18n-companion");
    if let Some(token) = payload.token.as_deref().filter(|token| !token.is_empty()) {
        request = request.header("authorization", format!("token {token}"));
    }
    github_response_from_response(request.json(&body).send().await?, None).await
}

fn token_missing(token: &Option<String>) -> bool {
    token.as_deref().unwrap_or_default().is_empty()
}

fn github_failure(message: impl Into<String>) -> GithubWriteResponse {
    GithubWriteResponse {
        state: false,
        data: Value::String(message.into()),
        status: None,
        scopes: None,
        is_rate_limit: None,
        has_open_issue: None,
    }
}

async fn github_get_user(state: &AppState, payload: &GithubReadRequest) -> Result<GithubReadResponse> {
    let response = github_api_get(state, payload, "https://api.github.com/user".to_string()).await?;
    let scopes = response
        .headers()
        .get("x-oauth-scopes")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    github_response_from_response(response, Some(scopes)).await
}

async fn github_get_file_content(state: &AppState, payload: &GithubReadRequest) -> Result<GithubReadResponse> {
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let path = required(&payload.path, "path")?;
    let mut url = format!("{}/contents/{}?t={}", github_repo_url(&owner, &repo), path, now_ms());
    if let Some(reference) = payload.r#ref.as_deref().or(payload.branch.as_deref()) {
        url.push_str("&ref=");
        url.push_str(reference);
    }
    github_get_json(state, payload, url).await
}

async fn github_get_file_content_with_fallback(state: &AppState, payload: &GithubReadRequest) -> Result<GithubReadResponse> {
    let branch = payload.branch.clone().unwrap_or_else(|| "main".to_string());
    let mut content_payload = payload.clone();
    content_payload.r#ref = Some(branch.clone());

    match github_get_file_content(state, &content_payload).await {
        Ok(response) if response.state => {
            if let Some(content) = response.data.get("content").and_then(Value::as_str) {
                let decoded = decode_github_content(content)?;
                return Ok(success_with_status(parse_text_or_json(decoded), response.status));
            }
            if let Some(download_url) = response.data.get("download_url").and_then(Value::as_str) {
                if let Ok(raw_response) = github_get_url(state, payload, download_url.to_string()).await {
                    let status = raw_response.status().as_u16();
                    let text = raw_response.text().await?;
                    return Ok(success_with_status(parse_text_or_json(text), Some(status)));
                }
            }
        }
        Ok(response) if response.status == Some(404) => return Ok(response),
        _ => {}
    }

    let mut raw_payload = payload.clone();
    raw_payload.branch = Some(branch);
    match github_get_raw_content(state, &raw_payload).await {
        Ok(response) if response.state => Ok(response),
        Ok(response) => Ok(GithubReadResponse {
            is_rate_limit: Some(matches!(response.status, Some(403 | 429))),
            ..response
        }),
        Err(error) => Ok(GithubReadResponse {
            state: false,
            data: Value::String(error.to_string()),
            status: None,
            scopes: None,
            is_rate_limit: None,
            has_open_issue: None,
        }),
    }
}

async fn github_get_raw_content(state: &AppState, payload: &GithubReadRequest) -> Result<GithubReadResponse> {
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let path = required(&payload.path, "path")?;
    let branch = payload.branch.as_deref().unwrap_or("main");
    let url = wrap_github_raw_proxy(
        &payload.github_proxy_url,
        &format!("https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}?t={}", now_ms()),
    );
    let response = github_get_url(state, payload, url).await?;
    let status = response.status().as_u16();
    if status >= 400 {
        return Ok(GithubReadResponse {
            state: false,
            data: response_body_value(response).await?,
            status: Some(status),
            scopes: None,
            is_rate_limit: None,
            has_open_issue: None,
        });
    }
    let text = response.text().await?;
    Ok(success_with_status(parse_text_or_json(text), Some(status)))
}

async fn github_download_asset(state: &AppState, payload: &GithubReadRequest) -> Result<GithubReadResponse> {
    let url = required(&payload.url, "url")?;
    let response = github_get_url(state, payload, url).await?;
    let status = response.status().as_u16();
    if status >= 400 {
        return Ok(GithubReadResponse {
            state: false,
            data: response_body_value(response).await?,
            status: Some(status),
            scopes: None,
            is_rate_limit: None,
            has_open_issue: None,
        });
    }
    Ok(success_with_status(Value::String(response.text().await?), Some(status)))
}

async fn github_check_open_registration_issue(state: &AppState, payload: &GithubReadRequest) -> Result<GithubReadResponse> {
    if payload.token.as_deref().unwrap_or_default().is_empty() {
        return Ok(GithubReadResponse {
            state: false,
            data: Value::String("请先在设置中配置 GitHub Token".to_string()),
            status: None,
            scopes: None,
            is_rate_limit: None,
            has_open_issue: Some(false),
        });
    }
    let target_owner = required(&payload.target_owner, "targetOwner")?;
    let target_repo = required(&payload.target_repo, "targetRepo")?;
    let repo_address = required(&payload.repo_address, "repoAddress")?;
    let creator = required(&payload.creator, "creator")?;
    let url = format!(
        "https://api.github.com/repos/{target_owner}/{target_repo}/issues?state=open&creator={creator}&t={}",
        now_ms()
    );
    let response = github_api_get(state, payload, url).await?;
    let status = response.status().as_u16();
    if status >= 400 {
        return Ok(GithubReadResponse {
            state: false,
            data: response_body_value(response).await?,
            status: Some(status),
            scopes: None,
            is_rate_limit: Some(status == 403 || status == 429),
            has_open_issue: Some(false),
        });
    }
    let issues = response_body_value(response).await?;
    let has_open_issue = issues.as_array().is_some_and(|items| {
        items.iter().any(|issue| {
            issue.get("title").and_then(Value::as_str).is_some_and(|title| title.contains(&repo_address))
                || issue.get("body").and_then(Value::as_str).is_some_and(|body| body.contains(&repo_address))
        })
    });
    Ok(GithubReadResponse {
        state: true,
        data: issues,
        status: Some(status),
        scopes: None,
        is_rate_limit: None,
        has_open_issue: Some(has_open_issue),
    })
}

async fn github_get_file_commits(state: &AppState, payload: &GithubReadRequest) -> Result<GithubReadResponse> {
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let path = required(&payload.path, "path")?;
    let page = payload.page.unwrap_or(1);
    let per_page = payload.per_page.unwrap_or(20);
    let url = format!("{}/commits?path={path}&page={page}&per_page={per_page}&t={}", github_repo_url(&owner, &repo), now_ms());
    github_get_json(state, payload, url).await
}

async fn github_get_file_at_commit(state: &AppState, payload: &GithubReadRequest) -> Result<GithubReadResponse> {
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let path = required(&payload.path, "path")?;
    let reference = required(&payload.r#ref, "ref")?;
    github_get_json(
        state,
        payload,
        format!("{}/contents/{path}?ref={reference}&t={}", github_repo_url(&owner, &repo), now_ms()),
    )
    .await
}

async fn github_get_repo_tree(state: &AppState, payload: &GithubReadRequest) -> Result<GithubReadResponse> {
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let tree_sha = payload.r#ref.as_deref().or(payload.branch.as_deref()).unwrap_or("main");
    let recursive = payload.recursive.unwrap_or(true);
    let suffix = if recursive { "?recursive=1" } else { "?" };
    github_get_json(
        state,
        payload,
        format!("{}/git/trees/{tree_sha}{suffix}&t={}", github_repo_url(&owner, &repo), now_ms()),
    )
    .await
}

async fn github_get_ref(state: &AppState, payload: &GithubReadRequest) -> Result<GithubReadResponse> {
    let owner = required(&payload.owner, "owner")?;
    let repo = required(&payload.repo, "repo")?;
    let reference = payload.r#ref.as_deref().unwrap_or("heads/main");
    github_get_json(
        state,
        payload,
        format!("{}/git/refs/{reference}?t={}", github_repo_url(&owner, &repo), now_ms()),
    )
    .await
}

async fn github_get_json(state: &AppState, payload: &GithubReadRequest, url: String) -> Result<GithubReadResponse> {
    let response = github_api_get(state, payload, url).await?;
    github_response_from_response(response, None).await
}

async fn github_response_from_response(
    response: reqwest::Response,
    scopes: Option<Vec<String>>,
) -> Result<GithubReadResponse> {
    let status = response.status().as_u16();
    let is_rate_limit = status == 403 || status == 429;
    let data = response_body_value(response).await?;
    Ok(GithubReadResponse {
        state: status < 400,
        data,
        status: Some(status),
        scopes,
        is_rate_limit: if is_rate_limit { Some(true) } else { None },
        has_open_issue: None,
    })
}

async fn github_api_get(
    state: &AppState,
    payload: &GithubReadRequest,
    url: String,
) -> Result<reqwest::Response> {
    let mut request = state
        .http
        .get(url)
        .timeout(Duration::from_millis(payload.timeout_ms.unwrap_or(10_000).max(1000)))
        .header("accept", "application/vnd.github.v3+json")
        .header("user-agent", "obsidian-i18n-companion");
    if let Some(token) = payload.token.as_deref().filter(|token| !token.is_empty()) {
        request = request.header("authorization", format!("token {token}"));
    }
    Ok(request.send().await?)
}

async fn github_get_url(
    state: &AppState,
    payload: &GithubReadRequest,
    url: String,
) -> Result<reqwest::Response> {
    let target = Url::parse(&url)?;
    if target.scheme() != "http" && target.scheme() != "https" {
        bail!("只允许 HTTP/HTTPS 请求");
    }
    Ok(state
        .http
        .get(target)
        .timeout(Duration::from_millis(payload.timeout_ms.unwrap_or(10_000).max(1000)))
        .header("user-agent", "obsidian-i18n-companion")
        .send()
        .await?)
}

fn github_repo_url(owner: &str, repo: &str) -> String {
    format!("https://api.github.com/repos/{owner}/{repo}")
}

fn required(value: &Option<String>, name: &str) -> Result<String> {
    value
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("缺少参数: {name}"))
}

fn decode_github_content(content: &str) -> Result<String> {
    let compact = content.replace(['\n', '\r'], "");
    let bytes = BASE64_STANDARD.decode(compact)?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn parse_text_or_json(text: String) -> Value {
    serde_json::from_str(&text).unwrap_or(Value::String(text))
}

async fn response_body_value(response: reqwest::Response) -> Result<Value> {
    let text = response.text().await?;
    if text.is_empty() {
        Ok(Value::Null)
    } else {
        Ok(parse_text_or_json(text))
    }
}

fn success_with_status(data: Value, status: Option<u16>) -> GithubReadResponse {
    GithubReadResponse {
        state: true,
        data,
        status,
        scopes: None,
        is_rate_limit: None,
        has_open_issue: None,
    }
}

fn wrap_github_raw_proxy(proxy: &Option<String>, url: &str) -> String {
    let Some(proxy) = proxy.as_deref().filter(|value| !value.is_empty()) else {
        return url.to_string();
    };
    if !url.contains("raw.githubusercontent.com") || url.starts_with(proxy) {
        return url.to_string();
    }
    if proxy.contains("jsdelivr.net") {
        return url
            .replace("https://raw.githubusercontent.com/", proxy)
            .replace("/master/", "@master/")
            .replace("/main/", "@main/");
    }
    if proxy.contains("statically.io") {
        return url.replace("https://raw.githubusercontent.com/", proxy);
    }
    let prefix = if proxy.ends_with('/') {
        proxy.to_string()
    } else {
        format!("{proxy}/")
    };
    format!("{prefix}{url}")
}

fn select_best_translation(payload: AutomationMatchRequest) -> Result<AutomationMatchResponse> {
    let has_language_match = payload.matches.iter().any(|candidate| {
        candidate
            .entry
            .get("language")
            .and_then(Value::as_str)
            .is_some_and(|language| language == payload.target_language)
    });

    let mut best_match: Option<AutomationMatchCandidate> = None;
    let mut best_score = -1_i64;
    let mut best_breakdown = ScoreInfo {
        version: 0,
        popularity: 0,
        freshness: 0,
        total: 0,
    };
    let now = now_ms() as i64;

    for candidate in payload.matches {
        if has_language_match {
            let language = candidate.entry.get("language").and_then(Value::as_str).unwrap_or_default();
            if language != payload.target_language {
                continue;
            }
        }

        let repo_stats = payload.stats.pointer(&format!("/repos/{}", escape_json_pointer(&candidate.repo_address)));
        let stars = repo_stats
            .and_then(|stats| stats.get("stars"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let activity = repo_stats
            .and_then(|stats| stats.get("activityScore"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);

        let cloud_version = candidate
            .entry
            .get("supported_versions")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let version_raw = if payload.is_theme {
            50.0
        } else {
            version_compatibility(cloud_version, &payload.target_version)
        };
        let version_score = (version_raw / 100.0) * 50.0;
        let star_score = ((stars / 500.0) * 20.0).min(20.0);
        let activity_score = (activity * 10.0).min(10.0);
        let popularity_score = star_score + activity_score;

        let updated_at = candidate
            .entry
            .get("updated_at")
            .and_then(Value::as_str)
            .and_then(parse_iso_ms)
            .unwrap_or(0);
        let days_since_update = (now - updated_at).max(0) as f64 / (1000.0 * 60.0 * 60.0 * 24.0);
        let freshness_score = if days_since_update <= 30.0 {
            20.0
        } else if days_since_update <= 90.0 {
            15.0
        } else if days_since_update <= 180.0 {
            10.0
        } else if days_since_update <= 365.0 {
            5.0
        } else {
            0.0
        };

        let total_raw = match payload.strategy.as_str() {
            "version_first" => (version_score * 1.5) + (popularity_score * 0.5) + (freshness_score * 0.5),
            "popularity" => (version_score * 0.5) + (popularity_score * 1.5) + (freshness_score * 0.5),
            "latest_update" => (version_score * 0.5) + (popularity_score * 0.5) + (freshness_score * 1.5),
            _ => version_score + popularity_score + freshness_score,
        };
        let total = (total_raw.round() as i64).min(100);
        if total > best_score {
            best_score = total;
            best_breakdown = ScoreInfo {
                version: version_score.round() as i64,
                popularity: popularity_score.round() as i64,
                freshness: freshness_score.round() as i64,
                total,
            };
            best_match = Some(candidate);
        }
    }

    Ok(AutomationMatchResponse {
        match_: best_match,
        score_info: best_breakdown,
    })
}

fn version_compatibility(cloud_version: &str, local_version: &str) -> f64 {
    if cloud_version == local_version {
        return 100.0;
    }
    let cloud_major = cloud_version.split('.').next().and_then(|value| value.parse::<i64>().ok());
    let local_major = local_version.split('.').next().and_then(|value| value.parse::<i64>().ok());
    if cloud_major.is_some() && cloud_major == local_major {
        50.0
    } else {
        0.0
    }
}

fn parse_iso_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
}

fn escape_json_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

async fn handle_cloud_publish_source(state: &AppState, payload: Value) -> Result<Value> {
    let payload: CloudTaskPayload = serde_json::from_value(payload)?;
    if token_missing(&payload.token) {
        return Ok(json!({ "state": false, "error": "GitHub Token 缺失" }));
    }
    let paths = paths(&payload.persistence.base_path);
    let source_id = payload.source_id.as_deref().ok_or_else(|| anyhow!("缺少 sourceId"))?;
    let source = load_meta(&paths)
        .pointer(&format!("/sources/{}", escape_pointer(source_id)))
        .cloned()
        .ok_or_else(|| anyhow!("翻译源不存在"))?;
    let content = read_translation(&paths, source_id).ok_or_else(|| anyhow!("翻译文件不存在"))?;
    let content_text = serde_json::to_string_pretty(&content)?;
    let hash = simple_hash(&content_text);
    let source_type = source.get("type").and_then(Value::as_str).unwrap_or("plugin");
    let plugin = source.get("plugin").and_then(Value::as_str).unwrap_or_default();
    let remote_path = cloud_file_path(source_id, source_type);
    let message_title = payload.title.as_deref().or_else(|| source.get("title").and_then(Value::as_str)).unwrap_or(source_id);
    let upload = github_upload_file(state, &GithubWriteRequest {
        operation: "uploadFile".to_string(),
        token: payload.token.clone(),
        owner: Some(payload.owner.clone()),
        repo: Some(payload.repo.clone()),
        path: Some(remote_path),
        content: Some(BASE64_STANDARD.encode(content_text.as_bytes())),
        message: Some(format!("Update translation: {message_title}")),
        branch: Some(payload.branch.clone()),
        sha: None,
        name: None,
        title: None,
        body: None,
        label: None,
        target_owner: None,
        target_repo: None,
        base_tree: None,
        tree_data: None,
        tree: None,
        parents: None,
        r#ref: None,
        files: None,
        timeout_ms: None,
    }).await?;
    if !upload.state {
        return Ok(json!({ "state": false, "error": upload.data }));
    }

    let (mut manifest, manifest_sha) = fetch_manifest_with_sha(state, &payload).await?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let existing_index = manifest.iter().position(|entry| entry.get("id").and_then(Value::as_str) == Some(source_id));
    let created_at = existing_index
        .and_then(|index| manifest[index].get("created_at").cloned())
        .unwrap_or_else(|| Value::String(now.clone()));
    let version = payload.version.clone().unwrap_or_default();
    let title = payload
        .title
        .clone()
        .unwrap_or_else(|| source.get("title").and_then(Value::as_str).unwrap_or(source_id).to_string());
    let description = payload.description.clone().unwrap_or_default();
    let mut entry = json!({
        "id": source_id,
        "plugin": plugin,
        "language": payload.language,
        "version": version,
        "supported_versions": version,
        "title": title,
        "description": description,
        "hash": hash,
        "created_at": created_at,
        "updated_at": now,
        "type": source_type,
    });
    if let Some(index) = existing_index {
        let existing = manifest[index].clone();
        merge_object(&mut entry, &existing, &["id", "plugin", "language", "type", "created_at"]);
        manifest[index] = entry;
        manifest = manifest
            .into_iter()
            .enumerate()
            .filter(|(item_index, item)| *item_index == index || item.get("id").and_then(Value::as_str) != Some(source_id))
            .map(|(_, item)| item)
            .collect();
    } else {
        manifest.push(entry);
    }

    upload_manifest(state, &payload, &manifest, manifest_sha).await?;
    let mut updated_source = source.clone();
    updated_source["origin"] = json!("cloud");
    updated_source["cloud"] = json!({ "owner": payload.owner, "repo": payload.repo, "hash": hash });
    updated_source["updatedAt"] = json!(now_ms());
    merge_metadata_index(&mut updated_source, &content, true);
    save_source_entry(state, &paths, source_id, updated_source.clone(), false).await?;
    Ok(json!({ "state": true, "manifest": manifest, "source": updated_source }))
}

async fn handle_cloud_download_source(state: &AppState, payload: Value) -> Result<Value> {
    let payload: CloudTaskPayload = serde_json::from_value(payload)?;
    let paths = paths(&payload.persistence.base_path);
    let entry = payload.entry.clone();
    let source_id = entry.get("id").and_then(Value::as_str).ok_or_else(|| anyhow!("缺少 entry.id"))?;
    let source_type = entry.get("type").and_then(Value::as_str).unwrap_or("plugin");
    let content = fetch_cloud_translation(state, &payload, source_id, source_type).await?;
    let existing = load_meta(&paths).pointer(&format!("/sources/{}", escape_pointer(source_id))).cloned();
    let should_activate = existing.is_none() && !has_any_sources_for_plugin(&paths, entry.get("plugin").and_then(Value::as_str).unwrap_or_default());
    let source = source_from_entry(&entry, &content, &payload.owner, &payload.repo, existing.as_ref(), should_activate)?;
    save_translation_and_source(state, &paths, source_id, &content, source.clone(), should_activate).await?;
    Ok(json!({ "state": true, "source": source }))
}

async fn handle_cloud_update_sources(state: &AppState, payload: Value) -> Result<Value> {
    let payload: CloudTaskPayload = serde_json::from_value(payload)?;
    let paths = paths(&payload.persistence.base_path);
    let mut updated = Vec::new();
    for entry in payload.manifest.iter() {
        let source_id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
        if source_id.is_empty() {
            continue;
        }
        let source_type = entry.get("type").and_then(Value::as_str).unwrap_or("plugin");
        let existing = load_meta(&paths).pointer(&format!("/sources/{}", escape_pointer(source_id))).cloned();
        if existing.is_none() {
            continue;
        }
        let content = fetch_cloud_translation(state, &payload, source_id, source_type).await?;
        let source = source_from_entry(entry, &content, &payload.owner, &payload.repo, existing.as_ref(), false)?;
        save_translation_and_source(state, &paths, source_id, &content, source.clone(), false).await?;
        updated.push(source);
    }
    Ok(json!({ "state": true, "sources": updated, "total": updated.len() }))
}

async fn handle_cloud_prepare_backup(_state: &AppState, payload: Value) -> Result<Value> {
    let payload: CloudTaskPayload = serde_json::from_value(payload)?;
    let paths = paths(&payload.persistence.base_path);
    let meta = load_meta(&paths);
    let mut manifest = payload.manifest;
    let mut files = Vec::new();
    let mut sources = Vec::new();
    if let Some(source_map) = meta.get("sources").and_then(Value::as_object) {
        for (source_id, source) in source_map {
            let Some(content) = read_translation(&paths, source_id) else {
                continue;
            };
            let content_text = serde_json::to_string_pretty(&content)?;
            let hash = simple_hash(&content_text);
            if manifest.iter().any(|entry| entry.get("id").and_then(Value::as_str) == Some(source_id) && entry.get("hash").and_then(Value::as_str) == Some(hash.as_str())) {
                continue;
            }
            let source_type = source.get("type").and_then(Value::as_str).unwrap_or("plugin");
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let existing_index = manifest.iter().position(|entry| entry.get("id").and_then(Value::as_str) == Some(source_id));
            let mut entry = json!({
                "id": source_id,
                "plugin": source.get("plugin").and_then(Value::as_str).unwrap_or_default(),
                "type": source_type,
                "language": payload.language,
                "version": content.pointer("/metadata/version").and_then(Value::as_str).unwrap_or_default(),
                "supported_versions": content.pointer("/metadata/supportedVersions").and_then(Value::as_str).unwrap_or_default(),
                "title": source.get("title").and_then(Value::as_str).unwrap_or("未命名翻译"),
                "description": content.pointer("/metadata/description").and_then(Value::as_str).unwrap_or_default(),
                "hash": hash,
                "created_at": existing_index.and_then(|index| manifest[index].get("created_at").and_then(Value::as_str)).unwrap_or(&now),
                "updated_at": now,
            });
            if let Some(index) = existing_index {
                let existing = manifest[index].clone();
                merge_object(&mut entry, &existing, &["created_at"]);
                manifest[index] = entry;
            } else {
                manifest.push(entry);
            }
            files.push(json!({ "path": cloud_file_path(source_id, source_type), "content": content_text }));
            let mut updated_source = source.clone();
            updated_source["origin"] = json!("cloud");
            updated_source["cloud"] = json!({ "owner": payload.owner, "repo": payload.repo, "hash": hash });
            updated_source["updatedAt"] = json!(now_ms());
            merge_metadata_index(&mut updated_source, &content, true);
            sources.push(updated_source);
        }
    }
    Ok(json!({ "state": true, "data": { "filesToUpload": files, "sourcesToSave": sources, "manifest": manifest }, "total": files.len() }))
}

async fn handle_cloud_restore_all(state: &AppState, payload: Value) -> Result<Value> {
    let payload: CloudTaskPayload = serde_json::from_value(payload)?;
    let paths = paths(&payload.persistence.base_path);
    let manifest = if payload.manifest.is_empty() {
        fetch_manifest(state, &payload).await?
    } else {
        payload.manifest.clone()
    };
    let mut restored = 0usize;
    let mut skipped = 0usize;
    for entry in manifest.iter() {
        let source_id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
        if source_id.is_empty() {
            continue;
        }
        if let Some(existing) = read_translation(&paths, source_id) {
            let local_hash = simple_hash(&serde_json::to_string_pretty(&existing)?);
            if entry.get("hash").and_then(Value::as_str) == Some(local_hash.as_str()) {
                skipped += 1;
                continue;
            }
        }
        let source_type = entry.get("type").and_then(Value::as_str).unwrap_or("plugin");
        let content = fetch_cloud_translation(state, &payload, source_id, source_type).await?;
        let existing = load_meta(&paths).pointer(&format!("/sources/{}", escape_pointer(source_id))).cloned();
        let should_activate = existing.is_none() && !has_any_sources_for_plugin(&paths, entry.get("plugin").and_then(Value::as_str).unwrap_or_default());
        let source = source_from_entry(entry, &content, &payload.owner, &payload.repo, existing.as_ref(), should_activate)?;
        save_translation_and_source(state, &paths, source_id, &content, source, should_activate).await?;
        restored += 1;
    }
    Ok(json!({ "state": true, "manifest": manifest, "restored": restored, "skipped": skipped, "total": manifest.len() }))
}

async fn handle_cloud_backup_all(
    state: &AppState,
    task: Arc<TaskRuntime>,
    payload: Value,
) -> Result<()> {
    let mut payload: CloudTaskPayload = serde_json::from_value(payload)?;
    if token_missing(&payload.token) {
        bail!("GitHub Token 缺失");
    }
    let paths = paths(&payload.persistence.base_path);
    let mut manifest = Vec::new();
    let mut files_to_upload = Vec::<GithubBatchUploadFile>::new();
    let mut sources_to_save = Vec::<Value>::new();
    let mut current_idx = 0usize;

    if payload.resume {
        if let Some(checkpoint) = load_backup_checkpoint(&paths) {
            files_to_upload = checkpoint_files(&checkpoint);
            sources_to_save = checkpoint
                .get("sourcesToSave")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            manifest = checkpoint
                .get("manifest")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            current_idx = checkpoint
                .get("currentIdx")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
        }
    }

    if files_to_upload.is_empty() && current_idx == 0 {
        touch_progress(&task, json!({ "currentLabel": "读取云端索引" })).await;
        manifest = fetch_manifest(state, &payload).await.unwrap_or_default();
        payload.manifest = manifest.clone();
        touch_progress(&task, json!({ "currentLabel": "准备备份数据" })).await;
        let prepared = handle_cloud_prepare_backup(state, serde_json::to_value(&payload)?).await?;
        if !prepared.get("state").and_then(Value::as_bool).unwrap_or(false) {
            bail!("{}", prepared.get("error").or_else(|| prepared.get("data")).unwrap_or(&Value::Null));
        }
        let data = prepared.get("data").cloned().unwrap_or_else(|| json!({}));
        files_to_upload = checkpoint_files(&data);
        sources_to_save = data
            .get("sourcesToSave")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        manifest = data
            .get("manifest")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or(manifest);
    }

    let total = files_to_upload.len();
    touch_progress(&task, json!({
        "totalResources": total,
        "totalItems": total,
        "processedResources": current_idx.min(total),
        "processedItems": current_idx.min(total),
        "successCount": current_idx.min(total),
    })).await;

    if total == 0 {
        clear_backup_checkpoint(&paths)?;
        bump_record_revision(&task).await;
        return Ok(());
    }

    current_idx = current_idx.min(total);
    while current_idx < total {
        ensure_not_cancelled(&task).await?;
        let end = (current_idx + CLOUD_BACKUP_CHUNK_SIZE).min(total);
        let chunk = files_to_upload[current_idx..end].to_vec();
        let batch_index = current_idx / CLOUD_BACKUP_CHUNK_SIZE + 1;
        let batch_total = total.div_ceil(CLOUD_BACKUP_CHUNK_SIZE);
        touch_progress(&task, json!({
            "currentLabel": format!("上传批次 {batch_index}/{batch_total}"),
            "processedResources": current_idx,
            "processedItems": current_idx,
        })).await;

        let upload = github_batch_upload_files(state, &GithubWriteRequest {
            operation: "batchUploadFiles".to_string(),
            token: payload.token.clone(),
            owner: Some(payload.owner.clone()),
            repo: Some(payload.repo.clone()),
            name: None,
            path: None,
            content: None,
            message: Some(format!("Bulk backup translations ({batch_index}/{batch_total})")),
            branch: Some(payload.branch.clone()),
            sha: None,
            title: None,
            body: None,
            label: None,
            target_owner: None,
            target_repo: None,
            base_tree: None,
            tree_data: None,
            tree: None,
            parents: None,
            r#ref: None,
            files: Some(chunk),
            timeout_ms: None,
        }).await?;
        if !upload.state {
            save_backup_checkpoint(&paths, &files_to_upload, &sources_to_save, &manifest, total, current_idx)?;
            bump_record_revision(&task).await;
            bail!("{}", upload.data);
        }

        current_idx = end;
        touch_progress(&task, json!({
            "processedResources": current_idx,
            "processedItems": current_idx,
            "successCount": current_idx,
        })).await;
        save_backup_checkpoint(&paths, &files_to_upload, &sources_to_save, &manifest, total, current_idx)?;
        bump_record_revision(&task).await;
    }

    ensure_not_cancelled(&task).await?;
    touch_progress(&task, json!({ "currentLabel": "更新云端索引" })).await;
    upload_manifest(state, &payload, &manifest, None).await?;

    ensure_not_cancelled(&task).await?;
    touch_progress(&task, json!({ "currentLabel": "同步本地元数据" })).await;
    save_backup_sources(state, &paths, &sources_to_save).await?;
    bump_source_revision(&task).await;
    clear_backup_checkpoint(&paths)?;
    bump_record_revision(&task).await;
    Ok(())
}

fn load_backup_checkpoint(paths: &PersistencePaths) -> Option<Value> {
    fs::read_to_string(&paths.checkpoint_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn save_backup_checkpoint(
    paths: &PersistencePaths,
    files_to_upload: &[GithubBatchUploadFile],
    sources_to_save: &[Value],
    manifest: &[Value],
    total: usize,
    current_idx: usize,
) -> Result<()> {
    write_json_pretty(&paths.checkpoint_path, &json!({
        "filesToUpload": files_to_upload,
        "sourcesToSave": sources_to_save,
        "manifest": manifest,
        "total": total,
        "currentIdx": current_idx,
        "timestamp": now_ms(),
    }))
}

fn clear_backup_checkpoint(paths: &PersistencePaths) -> Result<()> {
    match fs::remove_file(&paths.checkpoint_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn checkpoint_files(value: &Value) -> Vec<GithubBatchUploadFile> {
    value
        .get("filesToUpload")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|file| Some(GithubBatchUploadFile {
            path: file.get("path")?.as_str()?.to_string(),
            content: file.get("content")?.as_str()?.to_string(),
        }))
        .collect()
}

async fn save_backup_sources(
    state: &AppState,
    paths: &PersistencePaths,
    sources: &[Value],
) -> Result<()> {
    let _guard = state.persistence_lock.lock().await;
    let mut meta = load_meta(paths);
    if let Some(source_map) = meta.get_mut("sources").and_then(Value::as_object_mut) {
        for source in sources {
            if let Some(source_id) = source.get("id").and_then(Value::as_str) {
                source_map.insert(source_id.to_string(), source.clone());
            }
        }
    }
    write_json_pretty(&paths.meta_path, &meta)
}

async fn fetch_cloud_translation(state: &AppState, payload: &CloudTaskPayload, source_id: &str, source_type: &str) -> Result<Value> {
    let read = github_get_file_content_with_fallback(state, &GithubReadRequest {
        operation: "getFileContentWithFallback".to_string(),
        token: payload.token.clone(),
        github_proxy_url: None,
        owner: Some(payload.owner.clone()),
        repo: Some(payload.repo.clone()),
        path: Some(cloud_file_path(source_id, source_type)),
        branch: Some(payload.branch.clone()),
        r#ref: None,
        username: None,
        repo_name: None,
        url: None,
        target_owner: None,
        target_repo: None,
        repo_address: None,
        creator: None,
        page: None,
        per_page: None,
        recursive: None,
        timeout_ms: None,
    }).await?;
    if !read.state {
        bail!("下载翻译失败: {}", read.data);
    }
    Ok(match read.data {
        Value::String(text) => serde_json::from_str(&text)?,
        value => value,
    })
}

async fn fetch_manifest(state: &AppState, payload: &CloudTaskPayload) -> Result<Vec<Value>> {
    let (manifest, _) = fetch_manifest_with_sha(state, payload).await?;
    Ok(manifest)
}

async fn fetch_manifest_with_sha(state: &AppState, payload: &CloudTaskPayload) -> Result<(Vec<Value>, Option<String>)> {
    let read = github_get_file_content(state, &GithubReadRequest {
        operation: "getFileContent".to_string(),
        token: payload.token.clone(),
        github_proxy_url: None,
        owner: Some(payload.owner.clone()),
        repo: Some(payload.repo.clone()),
        path: Some("metadata.json".to_string()),
        branch: Some(payload.branch.clone()),
        r#ref: Some(payload.branch.clone()),
        username: None,
        repo_name: None,
        url: None,
        target_owner: None,
        target_repo: None,
        repo_address: None,
        creator: None,
        page: None,
        per_page: None,
        recursive: None,
        timeout_ms: None,
    }).await?;
    if !read.state {
        if read.status == Some(404) {
            return Ok((Vec::new(), None));
        }
        bail!("读取 metadata.json 失败: {}", read.data);
    }
    let sha = read.data.get("sha").and_then(Value::as_str).map(str::to_string);
    let manifest = if let Some(content) = read.data.get("content").and_then(Value::as_str) {
        let text = decode_github_content(content)?;
        serde_json::from_str::<Vec<Value>>(&text).unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok((manifest, sha))
}

async fn upload_manifest(state: &AppState, payload: &CloudTaskPayload, manifest: &[Value], sha: Option<String>) -> Result<()> {
    let content = BASE64_STANDARD.encode(serde_json::to_string_pretty(manifest)?.as_bytes());
    let response = github_upload_file(state, &GithubWriteRequest {
        operation: "uploadFile".to_string(),
        token: payload.token.clone(),
        owner: Some(payload.owner.clone()),
        repo: Some(payload.repo.clone()),
        path: Some("metadata.json".to_string()),
        content: Some(content),
        message: Some("Update metadata.json".to_string()),
        branch: Some(payload.branch.clone()),
        sha,
        name: None,
        title: None,
        body: None,
        label: None,
        target_owner: None,
        target_repo: None,
        base_tree: None,
        tree_data: None,
        tree: None,
        parents: None,
        r#ref: None,
        files: None,
        timeout_ms: None,
    }).await?;
    if !response.state {
        bail!("上传 metadata.json 失败: {}", response.data);
    }
    Ok(())
}

async fn save_translation_and_source(state: &AppState, paths: &PersistencePaths, source_id: &str, content: &Value, source: Value, activate: bool) -> Result<()> {
    let _guard = state.persistence_lock.lock().await;
    save_translation(paths, source_id, content)?;
    save_source_entry_locked(paths, source_id, source, activate)
}

async fn save_source_entry(state: &AppState, paths: &PersistencePaths, source_id: &str, source: Value, activate: bool) -> Result<()> {
    let _guard = state.persistence_lock.lock().await;
    save_source_entry_locked(paths, source_id, source, activate)
}

fn save_source_entry_locked(paths: &PersistencePaths, source_id: &str, source: Value, activate: bool) -> Result<()> {
    let mut meta = load_meta(paths);
    if let Some(sources) = meta.get_mut("sources").and_then(Value::as_object_mut) {
        if activate {
            let plugin = source.get("plugin").and_then(Value::as_str).unwrap_or_default().to_string();
            for existing in sources.values_mut() {
                if existing.get("plugin").and_then(Value::as_str) == Some(plugin.as_str()) {
                    existing["isActive"] = json!(false);
                }
            }
        }
        sources.insert(source_id.to_string(), source);
    }
    write_json_pretty(&paths.meta_path, &meta)
}

fn source_from_entry(entry: &Value, content: &Value, owner: &str, repo: &str, existing: Option<&Value>, activate: bool) -> Result<Value> {
    let source_id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
    let now = now_ms();
    let mut source = json!({
        "id": source_id,
        "plugin": entry.get("plugin").and_then(Value::as_str).unwrap_or_default(),
        "title": entry.get("title").and_then(Value::as_str).unwrap_or("未命名翻译"),
        "type": entry.get("type").and_then(Value::as_str).unwrap_or("plugin"),
        "origin": "cloud",
        "isActive": existing.and_then(|source| source.get("isActive")).and_then(Value::as_bool).unwrap_or(activate),
        "checksum": calculate_checksum(content)?,
        "cloud": { "owner": owner, "repo": repo, "hash": entry.get("hash").and_then(Value::as_str).unwrap_or_default() },
        "updatedAt": now,
        "createdAt": existing.and_then(|source| source.get("createdAt")).and_then(Value::as_u64).unwrap_or(now),
    });
    merge_metadata_index(&mut source, content, false);
    Ok(source)
}

fn has_existing_extracted_source(paths: &PersistencePaths, plugin_id: &str, source_type: &str, translation_version: &str) -> bool {
    load_meta(paths)
        .get("sources")
        .and_then(Value::as_object)
        .is_some_and(|sources| {
            sources.values().any(|source| {
                source.get("plugin").and_then(Value::as_str) == Some(plugin_id)
                    && source.get("type").and_then(Value::as_str) == Some(source_type)
                    && source.get("translationVersion").and_then(Value::as_str) == Some(translation_version)
                    && source
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|source_id| paths.sources_dir.join(format!("{source_id}.json")).exists())
            })
        })
}

fn has_any_sources_for_plugin(paths: &PersistencePaths, plugin_id: &str) -> bool {
    load_meta(paths)
        .get("sources")
        .and_then(Value::as_object)
        .is_some_and(|sources| sources.values().any(|source| source.get("plugin").and_then(Value::as_str) == Some(plugin_id)))
}

fn cloud_file_path(source_id: &str, source_type: &str) -> String {
    let dir = if source_type == "theme" { "themes" } else { "plugins" };
    format!("{dir}/{source_id}.json")
}

fn merge_object(target: &mut Value, existing: &Value, keys: &[&str]) {
    for key in keys {
        if let Some(value) = existing.get(*key) {
            target[*key] = value.clone();
        }
    }
}

fn simple_hash(text: &str) -> String {
    let mut hash: i32 = 0;
    for unit in text.encode_utf16() {
        hash = hash.wrapping_shl(5).wrapping_sub(hash).wrapping_add(unit as i32);
    }
    let hex = format!("{:x}", hash.unsigned_abs());
    let padded = format!("{hex:0>8}");
    padded.repeat(4)
}

async fn handle_sync_task(state: &AppState, task_type: &str, payload: Value) -> Result<Value> {
    match task_type {
        "ast-replace" => handle_ast_replace(payload).await,
        "code-extract" => handle_code_extract(payload).await,
        "plugin-apply-translation" => handle_plugin_apply_translation(payload).await,
        "plugin-diagnose-cleanup-start" => handle_plugin_diagnose_cleanup_start(state, payload).await,
        "plugin-diagnose-cleanup-step" => handle_plugin_diagnose_cleanup_step(state, payload).await,
        "theme-apply-translation" => handle_theme_apply_translation(payload).await,
        "source-export" | "source-read" | "source-import" | "source-remove" | "source-set-active" | "source-index" | "source-clear-batch-records" => handle_source_manager_task(state, task_type, payload).await,
        "plugin-extract" => Ok(serde_json::to_value(handle_plugin_extract(payload).await?)?),
        "theme-extract" => Ok(serde_json::to_value(handle_theme_extract(payload).await?)?),
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
        "cloud-publish-source" => handle_cloud_publish_source(state, payload).await,
        "cloud-download-source" => handle_cloud_download_source(state, payload).await,
        "cloud-update-sources" => handle_cloud_update_sources(state, payload).await,
        "cloud-prepare-backup" => handle_cloud_prepare_backup(state, payload).await,
        "cloud-restore-all" => handle_cloud_restore_all(state, payload).await,
        _ => Err(anyhow!("未知任务类型: {task_type}")),
    }
}

async fn handle_plugin_extract(payload: Value) -> Result<CompanionExtractResult> {
    tokio::task::spawn_blocking(move || handle_plugin_extract_blocking(payload)).await?
}

async fn handle_ast_replace(payload: Value) -> Result<Value> {
    tokio::task::spawn_blocking(move || {
        let payload: AstReplacePayload = serde_json::from_value(payload)?;
        let code = replace_ast_items_swc(&payload.code, &payload.translations)?;
        Ok(json!({ "state": true, "code": code }))
    })
    .await?
}

async fn handle_code_extract(payload: Value) -> Result<Value> {
    tokio::task::spawn_blocking(move || {
        let payload: CodeExtractPayload = serde_json::from_value(payload)?;
        let ast = extract_ast_items(&payload.code, &payload.settings);
        let regex = extract_regex_items(&payload.code, &payload.settings);
        Ok(json!({ "state": true, "ast": ast, "regex": regex }))
    })
    .await?
}

async fn handle_plugin_apply_translation(payload: Value) -> Result<Value> {
    tokio::task::spawn_blocking(move || {
        let payload: PluginApplyTranslationPayload = serde_json::from_value(payload)?;
        let response = apply_plugin_translation_blocking(payload)?;
        Ok(serde_json::to_value(response)?)
    })
    .await?
}

async fn handle_theme_apply_translation(payload: Value) -> Result<Value> {
    tokio::task::spawn_blocking(move || {
        let payload: ThemeApplyTranslationPayload = serde_json::from_value(payload)?;
        let response = apply_theme_translation_blocking(payload)?;
        Ok(serde_json::to_value(response)?)
    })
    .await?
}

async fn handle_source_manager_task(state: &AppState, operation: &str, payload: Value) -> Result<Value> {
    let operation = operation.to_string();
    let state = state.clone();
    let persistence_lock = state.persistence_lock.clone();
    let _guard = persistence_lock.lock().await;
    tokio::task::spawn_blocking(move || {
        let payload: SourceManagerPayload = serde_json::from_value(payload)?;
        let result = match operation.as_str() {
            "source-export" => source_export_blocking(payload)?,
            "source-read" => source_read_blocking(payload)?,
            "source-import" => source_import_blocking(payload)?,
            "source-remove" => source_remove_blocking(payload)?,
            "source-set-active" => source_set_active_blocking(payload)?,
            "source-index" => source_index_blocking(&state, payload)?,
            "source-clear-batch-records" => source_clear_batch_records_blocking(payload)?,
            _ => bail!("未知源管理操作: {operation}"),
        };
        Ok(serde_json::to_value(result)?)
    })
    .await?
}

fn resolve_apply_translation_json(
    translation_json: Option<Value>,
    persistence: Option<PersistenceConfig>,
    translation_source_id: Option<String>,
) -> Result<Value> {
    if let Some(content) = translation_json {
        return Ok(content);
    }
    let persistence = persistence.ok_or_else(|| anyhow!("persistence missing"))?;
    let source_id = translation_source_id.ok_or_else(|| anyhow!("translationSourceId missing"))?;
    let paths = paths(&persistence.base_path);
    read_translation(&paths, &source_id).ok_or_else(|| anyhow!("翻译文件不存在"))
}

fn apply_plugin_translation_blocking(payload: PluginApplyTranslationPayload) -> Result<ApplyTranslationResponse> {
    let translation_json = resolve_apply_translation_json(payload.translation_json, payload.persistence, payload.translation_source_id)?;
    let dict = translation_json
        .get("dict")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("translationJson.dict missing"))?;
    let files = dict.keys().cloned().collect::<Vec<_>>();
    create_plugin_backup(&payload.backup_base_path, &payload.plugin_id, &payload.plugin_dir, &files, false)?;
    let apply_ast = payload.apply_ast.unwrap_or(true);
    let apply_regex = payload.apply_regex.unwrap_or(true);

    let mut processed_files = 0usize;
    for (file, file_dict) in dict {
        let target_file_path = safe_join(&payload.plugin_dir, file)?;
        if !target_file_path.exists() {
            continue;
        }
        let mut file_string = read_backup_content(&payload.backup_base_path, &payload.plugin_id, file)?
            .unwrap_or_else(|| fs::read_to_string(&target_file_path).unwrap_or_default());

        if apply_ast {
            if let Some(ast) = file_dict.get("ast").and_then(Value::as_array) {
                if !ast.is_empty() {
                    file_string = replace_ast_items_swc(&file_string, ast)?;
                }
            }
        }
        if apply_regex {
            if let Some(regex) = file_dict.get("regex").and_then(Value::as_array) {
                if !regex.is_empty() {
                    file_string = apply_regex_translations(&file_string, regex);
                }
            }
        }
        fs::write(&target_file_path, file_string)
            .with_context(|| format!("failed to write {}", target_file_path.display()))?;
        processed_files += 1;
    }

    Ok(ApplyTranslationResponse {
        state: true,
        processed_files,
        translation_version: translation_json
            .pointer("/metadata/version")
            .and_then(Value::as_str)
            .unwrap_or("0.0.0")
            .to_string(),
    })
}

fn apply_theme_translation_blocking(payload: ThemeApplyTranslationPayload) -> Result<ApplyTranslationResponse> {
    let translation_json = resolve_apply_translation_json(payload.translation_json, payload.persistence, payload.translation_source_id)?;
    let dict = translation_json
        .get("dict")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("translationJson.dict missing"))?;
    let css_relative_path = payload.theme_css_relative_path.as_deref().unwrap_or("theme.css");
    create_plugin_backup(&payload.backup_base_path, &payload.theme_id, &payload.theme_dir, &[css_relative_path.to_string()], false)?;
    let theme_css_path = PathBuf::from(&payload.theme_css_path);
    let mut css = fs::read_to_string(&theme_css_path)
        .with_context(|| format!("failed to read {}", theme_css_path.display()))?;
    css = apply_theme_settings_translations(&css, dict);
    fs::write(&theme_css_path, css)
        .with_context(|| format!("failed to write {}", theme_css_path.display()))?;
    Ok(ApplyTranslationResponse {
        state: true,
        processed_files: 1,
        translation_version: translation_json
            .pointer("/metadata/version")
            .and_then(Value::as_str)
            .unwrap_or("1.0.0")
            .to_string(),
    })
}

fn safe_join(base: &str, relative: &str) -> Result<PathBuf> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute() || relative_path.components().any(|component| matches!(component, std::path::Component::ParentDir)) {
        bail!("invalid relative path: {relative}");
    }
    Ok(PathBuf::from(base).join(relative_path))
}

fn backup_dir(backup_base_path: &str) -> PathBuf {
    PathBuf::from(backup_base_path).join("backups")
}

fn plugin_backup_dir(backup_base_path: &str, plugin_id: &str) -> PathBuf {
    backup_dir(backup_base_path).join(plugin_id)
}

fn create_plugin_backup(
    backup_base_path: &str,
    plugin_id: &str,
    plugin_dir: &str,
    files: &[String],
    force: bool,
) -> Result<()> {
    let plugin_backup_dir = plugin_backup_dir(backup_base_path, plugin_id);
    fs::create_dir_all(&plugin_backup_dir)?;
    for file in files {
        let original_path = safe_join(plugin_dir, file)?;
        if !original_path.exists() {
            continue;
        }
        let backup_path = plugin_backup_dir.join(format!("{file}.gz"));
        if backup_path.exists() && !force {
            continue;
        }
        if let Some(parent) = backup_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let content = fs::read(&original_path)
            .with_context(|| format!("failed to read {}", original_path.display()))?;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&content)?;
        fs::write(&backup_path, encoder.finish()?)
            .with_context(|| format!("failed to write {}", backup_path.display()))?;
    }
    remove_legacy_backups(backup_base_path, plugin_id)?;
    Ok(())
}

fn remove_legacy_backups(backup_base_path: &str, plugin_id: &str) -> Result<()> {
    for path in [
        backup_dir(backup_base_path).join(format!("{plugin_id}.js.gz")),
        backup_dir(backup_base_path).join(format!("{plugin_id}.js")),
    ] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn read_backup_content(backup_base_path: &str, plugin_id: &str, file: &str) -> Result<Option<String>> {
    let backup_path = plugin_backup_dir(backup_base_path, plugin_id).join(format!("{file}.gz"));
    if backup_path.exists() {
        let compressed = fs::read(&backup_path)?;
        let mut decoder = GzDecoder::new(compressed.as_slice());
        let mut output = String::new();
        decoder.read_to_string(&mut output)?;
        return Ok(Some(output));
    }
    if file == "main.js" {
        let legacy_path = backup_dir(backup_base_path).join(format!("{plugin_id}.js.gz"));
        if legacy_path.exists() {
            let compressed = fs::read(&legacy_path)?;
            let mut decoder = GzDecoder::new(compressed.as_slice());
            let mut output = String::new();
            decoder.read_to_string(&mut output)?;
            return Ok(Some(output));
        }
    }
    Ok(None)
}

fn apply_regex_translations(code: &str, translations: &[Value]) -> String {
    let mut translated = code.to_string();
    for item in translations {
        let source = item.get("source").and_then(Value::as_str).unwrap_or_default();
        let target = item.get("target").and_then(Value::as_str).unwrap_or_default();
        if !source.is_empty() && !target.is_empty() && source != target {
            translated = translated.replace(source, target);
        }
    }
    translated
}

#[derive(Debug, Clone)]
struct TranslationCandidate {
    file: String,
    kind: String,
    index: usize,
    item: Value,
}

impl TranslationCandidate {
    fn issue(&self, reason: &str) -> TranslationIssueItem {
        TranslationIssueItem {
            file: self.file.clone(),
            kind: self.kind.clone(),
            index: self.index,
            source: self
                .item
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            target: self
                .item
                .get("target")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            reason: reason.to_string(),
        }
    }
}

fn is_active_translation_item(item: &Value) -> bool {
    let source = item.get("source").and_then(Value::as_str).unwrap_or_default();
    let target = item.get("target").and_then(Value::as_str).unwrap_or_default();
    !source.is_empty() && !target.is_empty() && source != target
}

fn is_javascript_file(file: &str) -> bool {
    file.ends_with(".js") || file.ends_with(".mjs") || file.ends_with(".cjs")
}

fn collect_translation_candidates(
    translation_json: &Value,
    apply_ast: bool,
    apply_regex: bool,
) -> Vec<TranslationCandidate> {
    let mut candidates = Vec::new();
    let Some(dict) = translation_json.get("dict").and_then(Value::as_object) else {
        return candidates;
    };

    for (file, file_dict) in dict {
        if !is_javascript_file(file) {
            continue;
        }
        if apply_ast {
            if let Some(items) = file_dict.get("ast").and_then(Value::as_array) {
                for (index, item) in items.iter().enumerate() {
                    if is_active_translation_item(item) {
                        candidates.push(TranslationCandidate {
                            file: file.clone(),
                            kind: "ast".to_string(),
                            index,
                            item: item.clone(),
                        });
                    }
                }
            }
        }
        if apply_regex {
            if let Some(items) = file_dict.get("regex").and_then(Value::as_array) {
                for (index, item) in items.iter().enumerate() {
                    if is_active_translation_item(item) {
                        candidates.push(TranslationCandidate {
                            file: file.clone(),
                            kind: "regex".to_string(),
                            index,
                            item: item.clone(),
                        });
                    }
                }
            }
        }
    }

    candidates
}

fn validate_translation_candidates(
    source_by_file: &HashMap<String, String>,
    candidates: &[TranslationCandidate],
) -> Result<()> {
    let mut grouped: HashMap<&str, (Vec<Value>, Vec<Value>)> = HashMap::new();
    for candidate in candidates {
        let entry = grouped.entry(candidate.file.as_str()).or_default();
        if candidate.kind == "ast" {
            entry.0.push(candidate.item.clone());
        } else if candidate.kind == "regex" {
            entry.1.push(candidate.item.clone());
        }
    }

    for (file, (ast_items, regex_items)) in grouped {
        if !is_javascript_file(file) {
            continue;
        }
        let Some(original_code) = source_by_file.get(file) else {
            continue;
        };
        let mut code = original_code.clone();
        if !ast_items.is_empty() {
            code = replace_ast_items_swc(&code, &ast_items)
                .with_context(|| format!("{file} AST 替换失败"))?;
        }
        if !regex_items.is_empty() {
            code = apply_regex_translations(&code, &regex_items);
        }
        parse_swc_module(&code).with_context(|| format!("{file} 语法校验失败"))?;
    }

    Ok(())
}

fn translation_candidates_fail(
    source_by_file: &HashMap<String, String>,
    candidates: &[TranslationCandidate],
) -> Option<String> {
    validate_translation_candidates(source_by_file, candidates)
        .err()
        .map(|error| error.to_string())
}

fn partition_candidates(candidates: &[TranslationCandidate], parts: usize) -> Vec<Vec<TranslationCandidate>> {
    if parts == 0 || candidates.is_empty() {
        return Vec::new();
    }
    let chunk_size = (candidates.len() + parts - 1) / parts;
    candidates
        .chunks(chunk_size.max(1))
        .map(|chunk| chunk.to_vec())
        .collect()
}

fn complement_candidates(
    candidates: &[TranslationCandidate],
    remove_start: usize,
    remove_len: usize,
) -> Vec<TranslationCandidate> {
    candidates
        .iter()
        .enumerate()
        .filter(|(index, _)| *index < remove_start || *index >= remove_start + remove_len)
        .map(|(_, item)| item.clone())
        .collect()
}

fn minimize_failing_translation_set(
    source_by_file: &HashMap<String, String>,
    candidates: &[TranslationCandidate],
) -> Vec<TranslationCandidate> {
    if candidates.len() <= 1 {
        return candidates.to_vec();
    }

    let mut current = candidates.to_vec();
    let mut granularity = 2usize;
    while current.len() >= 2 {
        let chunks = partition_candidates(&current, granularity.min(current.len()));
        let mut reduced = false;

        for chunk in &chunks {
            if translation_candidates_fail(source_by_file, chunk).is_some() {
                current = chunk.clone();
                granularity = 2;
                reduced = true;
                break;
            }
        }
        if reduced {
            continue;
        }

        let mut offset = 0usize;
        for chunk in chunks {
            let complement = complement_candidates(&current, offset, chunk.len());
            offset += chunk.len();
            if complement.is_empty() {
                continue;
            }
            if translation_candidates_fail(source_by_file, &complement).is_some() {
                current = complement;
                granularity = granularity.saturating_sub(1).max(2);
                reduced = true;
                break;
            }
        }
        if reduced {
            continue;
        }

        if granularity >= current.len() {
            break;
        }
        granularity = (granularity * 2).min(current.len());
    }

    current
}

fn remove_translation_candidates(translation_json: &mut Value, candidates: &[TranslationCandidate]) -> usize {
    let mut grouped: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for candidate in candidates {
        grouped
            .entry((candidate.file.clone(), candidate.kind.clone()))
            .or_default()
            .push(candidate.index);
    }

    let Some(dict) = translation_json.get_mut("dict").and_then(Value::as_object_mut) else {
        return 0;
    };
    let mut removed = 0usize;
    for ((file, kind), mut indexes) in grouped {
        indexes.sort_unstable();
        indexes.dedup();
        let Some(items) = dict
            .get_mut(&file)
            .and_then(|file_dict| file_dict.get_mut(&kind))
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for index in indexes.into_iter().rev() {
            if index < items.len() {
                items.remove(index);
                removed += 1;
            }
        }
    }
    removed
}

fn validate_original_sources(source_by_file: &HashMap<String, String>) -> Result<()> {
    for (file, code) in source_by_file {
        if !is_javascript_file(file) {
            continue;
        }
        parse_swc_module(code).with_context(|| format!("{file} 原始脚本语法错误，无法诊断"))?;
    }
    Ok(())
}

fn diagnose_and_clean_translation_json(
    translation_json: &mut Value,
    source_by_file: &HashMap<String, String>,
    apply_ast: bool,
    apply_regex: bool,
) -> Result<TranslationCleanupReport> {
    validate_original_sources(source_by_file)?;
    let mut removed_items = Vec::new();

    loop {
        let candidates = collect_translation_candidates(translation_json, apply_ast, apply_regex);
        if candidates.is_empty() {
            break;
        }
        let Some(batch_reason) = translation_candidates_fail(source_by_file, &candidates) else {
            break;
        };

        let mut failing = Vec::new();
        for candidate in &candidates {
            if let Some(reason) = translation_candidates_fail(source_by_file, std::slice::from_ref(candidate)) {
                removed_items.push(candidate.issue(&reason));
                failing.push(candidate.clone());
            }
        }

        if failing.is_empty() {
            failing = minimize_failing_translation_set(source_by_file, &candidates);
            let reason = if failing.len() > 1 {
                format!("组合导致脚本验证失败: {batch_reason}")
            } else {
                batch_reason
            };
            for candidate in &failing {
                removed_items.push(candidate.issue(&reason));
            }
        }

        if remove_translation_candidates(translation_json, &failing) == 0 {
            bail!("诊断发现问题条目但移除失败");
        }
    }

    Ok(TranslationCleanupReport {
        state: true,
        processed_files: source_by_file.len(),
        removed_items,
    })
}

fn source_by_file_for_plugin(
    plugin_id: &str,
    plugin_dir: &str,
    backup_base_path: &str,
    translation_json: &Value,
    is_applied: bool,
) -> Result<HashMap<String, String>> {
    let mut source_by_file = HashMap::new();
    let dict = translation_json
        .get("dict")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("translationJson.dict missing"))?;

    for file in dict.keys() {
        let target_file_path = safe_join(plugin_dir, file)?;
        let content = if !is_applied && target_file_path.exists() {
            fs::read_to_string(&target_file_path)
                .with_context(|| format!("failed to read {}", target_file_path.display()))?
        } else if let Some(backup) = read_backup_content(backup_base_path, plugin_id, file)? {
            backup
        } else if is_applied {
            bail!("{file} 已应用翻译但未找到原始备份，无法安全诊断");
        } else if target_file_path.exists() {
            fs::read_to_string(&target_file_path)
                .with_context(|| format!("failed to read {}", target_file_path.display()))?
        } else {
            continue;
        };
        source_by_file.insert(file.clone(), content);
    }

    Ok(source_by_file)
}

fn save_cleaned_translation_source(
    paths: &PersistencePaths,
    source_id: &str,
    translation_json: &Value,
) -> Result<()> {
    save_translation(paths, source_id, translation_json)?;
    let mut meta = load_meta(paths);
    if let Some(source) = meta
        .get_mut("sources")
        .and_then(Value::as_object_mut)
        .and_then(|sources| sources.get_mut(source_id))
    {
        source["checksum"] = json!(calculate_checksum(translation_json)?);
        source["updatedAt"] = json!(now_ms());
        merge_metadata_index(source, translation_json, true);
        merge_source_file_mtime(source, paths, source_id);
        write_json_pretty(&paths.meta_path, &meta)?;
    }
    Ok(())
}

fn render_probe_files(
    source_by_file: &HashMap<String, String>,
    candidates: &[TranslationCandidate],
) -> Result<Vec<RuntimeProbeFile>> {
    let mut grouped: HashMap<&str, (Vec<Value>, Vec<Value>)> = HashMap::new();
    for candidate in candidates {
        let entry = grouped.entry(candidate.file.as_str()).or_default();
        if candidate.kind == "ast" {
            entry.0.push(candidate.item.clone());
        } else if candidate.kind == "regex" {
            entry.1.push(candidate.item.clone());
        }
    }

    let mut files = Vec::new();
    let mut file_names = source_by_file.keys().cloned().collect::<Vec<_>>();
    file_names.sort();
    for file in file_names {
        if !is_javascript_file(&file) {
            continue;
        }
        let mut code = source_by_file.get(&file).cloned().unwrap_or_default();
        if let Some((ast_items, regex_items)) = grouped.get(file.as_str()) {
            if !ast_items.is_empty() {
                code = replace_ast_items_swc(&code, ast_items)?;
            }
            if !regex_items.is_empty() {
                code = apply_regex_translations(&code, regex_items);
            }
        }
        files.push(RuntimeProbeFile { file, code });
    }
    Ok(files)
}

fn candidate_identity(candidate: &TranslationCandidate) -> (String, String, usize, String, String) {
    (
        candidate.file.clone(),
        candidate.kind.clone(),
        candidate.index,
        candidate
            .item
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        candidate
            .item
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    )
}

fn same_candidate_set(left: &[TranslationCandidate], right: &[TranslationCandidate]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let left_set = left.iter().map(candidate_identity).collect::<HashSet<_>>();
    let right_set = right.iter().map(candidate_identity).collect::<HashSet<_>>();
    left_set == right_set
}

fn candidate_group_signature(candidates: &[TranslationCandidate]) -> String {
    let mut parts = candidates
        .iter()
        .map(|candidate| {
            let (file, kind, index, source, target) = candidate_identity(candidate);
            format!("{file}\u{1f}{kind}\u{1f}{index}\u{1f}{source}\u{1f}{target}")
        })
        .collect::<Vec<_>>();
    parts.sort();
    parts.join("\u{1e}")
}

fn pairwise_candidate_groups(candidates: &[TranslationCandidate]) -> Vec<Vec<TranslationCandidate>> {
    let mut groups = Vec::new();
    if candidates.len() <= 2 || candidates.len() > 64 {
        return groups;
    }
    for left in 0..candidates.len() {
        for right in (left + 1)..candidates.len() {
            groups.push(vec![candidates[left].clone(), candidates[right].clone()]);
        }
    }
    groups
}

fn probe_response(
    session_id: &str,
    session: &mut DiagnoseCleanupSession,
    candidates: Vec<TranslationCandidate>,
    label: &str,
) -> Result<PluginDiagnoseCleanupResponse> {
    let probe_id = nanoid!(16);
    let files = render_probe_files(&session.source_by_file, &candidates)?;
    session.probe_map.insert(probe_id.clone(), candidates);
    Ok(PluginDiagnoseCleanupResponse {
        state: true,
        status: "probe".to_string(),
        session_id: Some(session_id.to_string()),
        probe: Some(RuntimeProbeRequest {
            probe_id,
            files,
            label: label.to_string(),
        }),
        removed_items: session.removed_items.clone(),
        processed_files: session.processed_files,
        translation_version: session
            .translation_json
            .pointer("/metadata/version")
            .and_then(Value::as_str)
            .unwrap_or("0.0.0")
            .to_string(),
    })
}

fn completed_response(session: &DiagnoseCleanupSession, status: &str) -> PluginDiagnoseCleanupResponse {
    PluginDiagnoseCleanupResponse {
        state: true,
        status: status.to_string(),
        session_id: None,
        probe: None,
        removed_items: session.removed_items.clone(),
        processed_files: session.processed_files,
        translation_version: session
            .translation_json
            .pointer("/metadata/version")
            .and_then(Value::as_str)
            .unwrap_or("0.0.0")
            .to_string(),
    }
}

fn runtime_probe_chunks(candidates: &[TranslationCandidate]) -> Vec<Vec<TranslationCandidate>> {
    if candidates.len() <= 1 {
        return vec![candidates.to_vec()];
    }
    partition_candidates(candidates, 2)
}

fn remove_runtime_candidates(
    session: &mut DiagnoseCleanupSession,
    candidates: Vec<TranslationCandidate>,
    reason: &str,
) -> Result<()> {
    for candidate in &candidates {
        session.removed_items.push(candidate.issue(reason));
    }
    if remove_translation_candidates(&mut session.translation_json, &candidates) == 0 {
        bail!("运行诊断发现问题条目但移除失败");
    }
    save_cleaned_translation_source(
        &session.paths,
        &session.translation_source_id,
        &session.translation_json,
    )?;
    session.pending_candidates = collect_translation_candidates(
        &session.translation_json,
        session.apply_ast,
        session.apply_regex,
    );
    session.runtime_probe_queue.clear();
    session.combo_fallback_groups.clear();
    session.pairwise_tested_group_signatures.clear();
    session.probe_map.clear();
    Ok(())
}

fn next_runtime_probe_response(
    session_id: &str,
    session: &mut DiagnoseCleanupSession,
) -> Result<Option<PluginDiagnoseCleanupResponse>> {
    if session.pending_candidates.is_empty() {
        return Ok(None);
    }

    if let Some(candidates) = session.runtime_probe_queue.pop() {
        return probe_response(session_id, session, candidates, "分组运行验证").map(Some);
    }

    if let Some(group) = session.combo_fallback_groups.pop() {
        let signature = candidate_group_signature(&group);
        if !session.pairwise_tested_group_signatures.contains(&signature) {
            let pairwise = pairwise_candidate_groups(&group);
            if !pairwise.is_empty() {
                session.pairwise_tested_group_signatures.insert(signature);
                session.combo_fallback_groups.push(group.clone());
                for pair in pairwise.into_iter().rev() {
                    session.runtime_probe_queue.push(pair);
                }
                if let Some(candidates) = session.runtime_probe_queue.pop() {
                    return probe_response(session_id, session, candidates, "组合运行验证").map(Some);
                }
            }
        }
        remove_runtime_candidates(
            session,
            group,
            "组合导致插件运行验证失败，已移除该最小失败集合",
        )?;
        if session.pending_candidates.is_empty() {
            return Ok(None);
        }
    }

    probe_response(
        session_id,
        session,
        session.pending_candidates.clone(),
        "全量运行验证",
    )
    .map(Some)
}

async fn handle_plugin_diagnose_cleanup_start(
    state: &AppState,
    payload: Value,
) -> Result<Value> {
    let _guard = state.persistence_lock.lock().await;
    let payload: PluginDiagnoseCleanupStartPayload = serde_json::from_value(payload)?;
    let paths = paths(&payload.persistence.base_path);
    let mut translation_json = read_translation(&paths, &payload.translation_source_id)
        .ok_or_else(|| anyhow!("翻译文件不存在"))?;
    let apply_ast = payload.apply_ast.unwrap_or(true);
    let apply_regex = payload.apply_regex.unwrap_or(true);
    let source_by_file = source_by_file_for_plugin(
        &payload.plugin_id,
        &payload.plugin_dir,
        &payload.backup_base_path,
        &translation_json,
        payload.is_applied.unwrap_or(false),
    )?;
    let static_report = diagnose_and_clean_translation_json(
        &mut translation_json,
        &source_by_file,
        apply_ast,
        apply_regex,
    )?;
    save_cleaned_translation_source(&paths, &payload.translation_source_id, &translation_json)?;

    let pending_candidates = collect_translation_candidates(&translation_json, apply_ast, apply_regex);
    let mut session = DiagnoseCleanupSession {
        paths,
        translation_source_id: payload.translation_source_id,
        translation_json,
        source_by_file,
        apply_ast,
        apply_regex,
        removed_items: static_report.removed_items,
        pending_candidates,
        probe_map: HashMap::new(),
        runtime_probe_queue: Vec::new(),
        combo_fallback_groups: Vec::new(),
        pairwise_tested_group_signatures: HashSet::new(),
        processed_files: static_report.processed_files,
    };

    if !payload.runtime_probe.unwrap_or(false) || session.pending_candidates.is_empty() {
        return Ok(serde_json::to_value(completed_response(&session, "completed"))?);
    }

    let session_id = nanoid!(16);
    let response = probe_response(
        &session_id,
        &mut session,
        Vec::new(),
        "原始运行验证",
    )?;
    state
        .diagnose_sessions
        .lock()
        .await
        .insert(session_id, session);
    Ok(serde_json::to_value(response)?)
}

async fn handle_plugin_diagnose_cleanup_step(
    state: &AppState,
    payload: Value,
) -> Result<Value> {
    let _guard = state.persistence_lock.lock().await;
    let payload: PluginDiagnoseCleanupStepPayload = serde_json::from_value(payload)?;
    let mut sessions = state.diagnose_sessions.lock().await;
    let session = sessions
        .get_mut(&payload.session_id)
        .ok_or_else(|| anyhow!("诊断会话不存在或已结束"))?;
    let candidates = session
        .probe_map
        .remove(&payload.probe_id)
        .ok_or_else(|| anyhow!("诊断探针不存在或已处理"))?;

    if candidates.is_empty() {
        if !payload.success {
            let response = completed_response(session, "baselineFailed");
            sessions.remove(&payload.session_id);
            return Ok(serde_json::to_value(response)?);
        }
        if let Some(response) = next_runtime_probe_response(&payload.session_id, session)? {
            return Ok(serde_json::to_value(response)?);
        }
        let response = completed_response(session, "completed");
        sessions.remove(&payload.session_id);
        return Ok(serde_json::to_value(response)?);
    }

    if payload.success {
        if same_candidate_set(&candidates, &session.pending_candidates) {
            save_cleaned_translation_source(
                &session.paths,
                &session.translation_source_id,
                &session.translation_json,
            )?;
            let response = completed_response(session, "completed");
            sessions.remove(&payload.session_id);
            return Ok(serde_json::to_value(response)?);
        }
    } else if candidates.len() <= 1 {
        let reason = payload
            .error
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("插件运行验证失败");
        remove_runtime_candidates(session, candidates, reason)?;
    } else {
        session.combo_fallback_groups.push(candidates.clone());
        for chunk in runtime_probe_chunks(&candidates).into_iter().rev() {
            session.runtime_probe_queue.push(chunk);
        }
    }

    if let Some(response) = next_runtime_probe_response(&payload.session_id, session)? {
        Ok(serde_json::to_value(response)?)
    } else {
        save_cleaned_translation_source(
            &session.paths,
            &session.translation_source_id,
            &session.translation_json,
        )?;
        let response = completed_response(session, "completed");
        sessions.remove(&payload.session_id);
        Ok(serde_json::to_value(response)?)
    }
}

fn apply_theme_settings_translations(css: &str, translations: &[Value]) -> String {
    let Ok(block_re) = Regex::new(r"(?s)/\* @settings(.*?)\*/") else {
        return css.to_string();
    };
    block_re
        .replace_all(css, |captures: &regex::Captures| {
            let block_content = captures.get(1).map(|m| m.as_str()).unwrap_or_default();
            let mut new_block_content = block_content.to_string();
            for item in translations {
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                let source = item.get("source").and_then(Value::as_str).unwrap_or_default();
                let target = item.get("target").and_then(Value::as_str).unwrap_or_default();
                if item_type.is_empty() || source.is_empty() || target.is_empty() || source == target {
                    continue;
                }
                new_block_content = replace_theme_setting_value(&new_block_content, item_type, source, target);
            }
            format!("/* @settings{new_block_content}*/")
        })
        .to_string()
}

fn replace_theme_setting_value(block: &str, item_type: &str, source: &str, target: &str) -> String {
    let mut output = String::new();
    for segment in block.split_inclusive('\n') {
        let has_newline = segment.ends_with('\n');
        let line = segment.trim_end_matches(['\r', '\n']);
        if let Some(replaced) = replace_theme_setting_line(line, item_type, source, target) {
            output.push_str(&replaced);
            if has_newline {
                output.push('\n');
            }
        } else {
            output.push_str(segment);
        }
    }
    if !block.ends_with('\n') {
        return output;
    }
    output
}

fn replace_theme_setting_line(line: &str, item_type: &str, source: &str, target: &str) -> Option<String> {
    let indent_len = line.len() - line.trim_start_matches([' ', '\t']).len();
    let indent = &line[..indent_len];
    let rest = &line[indent_len..];
    let key_end = rest.find(':')?;
    let key = rest[..key_end].trim();
    if key != item_type {
        return None;
    }
    let mut value = rest[key_end + 1..].trim();
    let quote = value.chars().next().filter(|ch| *ch == '\'' || *ch == '"').unwrap_or('\0');
    if quote != '\0' {
        value = value.strip_prefix(quote)?.strip_suffix(quote)?;
    }
    if value != source {
        return None;
    }
    let quote_text = if quote == '\0' { "" } else if quote == '\'' { "'" } else { "\"" };
    Some(format!("{indent}{key}: {quote_text}{target}{quote_text}"))
}

fn handle_plugin_extract_blocking(payload: Value) -> Result<CompanionExtractResult> {
    let payload: PluginExtractPayload = serde_json::from_value(payload)?;
    let result = (|| -> Result<CompanionExtractResult> {
        let main_doc = PathBuf::from(&payload.main_doc);
        if !main_doc.exists() {
            bail!("main.js 不存在");
        }
        let manifest_doc = PathBuf::from(&payload.manifest_doc);
        let main_str = fs::read_to_string(&main_doc)
            .with_context(|| format!("failed to read {}", main_doc.display()))?;
        let manifest = read_json_file(&manifest_doc).context("manifest.json 不存在或格式错误")?;
        let plugin_name = manifest
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&payload.plugin_name);
        let manifest_description = manifest
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let metadata_text = format!("{}\n{}", plugin_name, manifest_description);
        if is_chinese_skip_mode(&payload.settings, "source")
            && should_skip_chinese_by_source(&metadata_text, &main_str)
        {
            return Ok(CompanionExtractResult {
                status: "skipped".to_string(),
                resource_id: payload.resource_id.clone(),
                label: payload.label.clone(),
                plugin_id: None,
                content: None,
                options: None,
                reason: Some("chinese".to_string()),
                error: None,
            });
        }

        let plugin_id = manifest
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(&payload.resource_id);
        let ast = extract_ast_items(&main_str, &payload.settings);
        let regex = extract_regex_items(&main_str, &payload.settings);
        let sources = ast
            .iter()
            .chain(regex.iter())
            .filter_map(|item| item.get("source").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        if is_chinese_skip_mode(&payload.settings, "extracted")
            && should_skip_chinese_by_extracted_items(&metadata_text, &sources)
        {
            return Ok(CompanionExtractResult {
                status: "skipped".to_string(),
                resource_id: payload.resource_id.clone(),
                label: payload.label.clone(),
                plugin_id: None,
                content: None,
                options: None,
                reason: Some("chinese".to_string()),
                error: None,
            });
        }
        let extraction_enabled = payload.settings.ast_extraction_enabled || payload.settings.re_extraction_enabled;
        if extraction_enabled && !has_extracted_translation_content(&sources) {
            return Ok(CompanionExtractResult {
                status: "skipped".to_string(),
                resource_id: payload.resource_id.clone(),
                label: payload.label.clone(),
                plugin_id: None,
                content: None,
                options: None,
                reason: Some("empty".to_string()),
                error: None,
            });
        }

        let content = json!({
            "schemaVersion": 1,
            "metadata": {
                "plugin": plugin_id,
                "version": payload.settings.translation_version.clone(),
                "title": plugin_name,
                "description": format!("{} Localization & Tweaks", plugin_name),
                "language": payload.language.clone(),
                "supportedVersions": payload.plugin_version.clone(),
                "author": payload.settings.author.clone(),
            },
            "dict": {
                "main.js": {
                    "ast": ast,
                    "regex": regex,
                }
            }
        });

        Ok(CompanionExtractResult {
            status: "success".to_string(),
            resource_id: payload.resource_id.clone(),
            label: payload.label.clone(),
            plugin_id: Some(payload.resource_id.clone()),
            content: Some(content),
            options: Some(json!({ "title": payload.plugin_name.clone() })),
            reason: None,
            error: None,
        })
    })();

    Ok(match result {
        Ok(result) => result,
        Err(error) => CompanionExtractResult {
            status: "failed".to_string(),
            resource_id: payload.resource_id,
            label: payload.label,
            plugin_id: None,
            content: None,
            options: None,
            reason: None,
            error: Some(error.to_string()),
        },
    })
}

async fn handle_theme_extract(payload: Value) -> Result<CompanionExtractResult> {
    tokio::task::spawn_blocking(move || handle_theme_extract_blocking(payload)).await?
}

fn handle_theme_extract_blocking(payload: Value) -> Result<CompanionExtractResult> {
    let payload: ThemeExtractPayload = serde_json::from_value(payload)?;
    let result = (|| -> Result<CompanionExtractResult> {
        let theme_css_path = PathBuf::from(&payload.theme_css_path);
        if !theme_css_path.exists() {
            bail!("theme.css 不存在");
        }
        let css_str = fs::read_to_string(&theme_css_path)
            .with_context(|| format!("failed to read {}", theme_css_path.display()))?;
        let manifest_path = PathBuf::from(&payload.theme_dir).join("manifest.json");
        let manifest = read_json_file(&manifest_path).unwrap_or_else(|| json!({
            "name": payload.theme_name.clone(),
            "version": "0.0.0",
            "minAppVersion": "",
            "author": "",
            "authorUrl": "",
        }));
        let theme_name = manifest
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&payload.theme_name);
        if is_chinese_skip_mode(&payload.settings, "source")
            && should_skip_chinese_by_source(theme_name, &css_str)
        {
            return Ok(CompanionExtractResult {
                status: "skipped".to_string(),
                resource_id: payload.resource_id.clone(),
                label: payload.label.clone(),
                plugin_id: None,
                content: None,
                options: None,
                reason: Some("chinese".to_string()),
                error: None,
            });
        }
        let dict = extract_theme_items(&css_str);
        let sources = dict
            .iter()
            .filter_map(|item| item.get("source").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        if is_chinese_skip_mode(&payload.settings, "extracted")
            && should_skip_chinese_by_extracted_items(theme_name, &sources)
        {
            return Ok(CompanionExtractResult {
                status: "skipped".to_string(),
                resource_id: payload.resource_id.clone(),
                label: payload.label.clone(),
                plugin_id: None,
                content: None,
                options: None,
                reason: Some("chinese".to_string()),
                error: None,
            });
        }
        if !has_extracted_translation_content(&sources) {
            return Ok(CompanionExtractResult {
                status: "skipped".to_string(),
                resource_id: payload.resource_id.clone(),
                label: payload.label.clone(),
                plugin_id: None,
                content: None,
                options: None,
                reason: Some("empty".to_string()),
                error: None,
            });
        }
        let version = manifest
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("0.0.0");
        let content = json!({
            "schemaVersion": 1,
            "metadata": {
                "theme": theme_name,
                "language": "zh-cn",
                "version": payload.settings.translation_version.clone(),
                "supportedVersions": version,
                "title": theme_name,
                "description": format!("{} Localization & Tweaks", theme_name),
                "author": payload.settings.author.clone(),
            },
            "dict": dict,
        });
        Ok(CompanionExtractResult {
            status: "success".to_string(),
            resource_id: payload.resource_id.clone(),
            label: payload.label.clone(),
            plugin_id: Some(payload.theme_name.clone()),
            content: Some(content),
            options: Some(json!({ "title": payload.theme_name.clone(), "type": "theme" })),
            reason: None,
            error: None,
        })
    })();

    Ok(match result {
        Ok(result) => result,
        Err(error) => CompanionExtractResult {
            status: "failed".to_string(),
            resource_id: payload.resource_id,
            label: payload.label,
            plugin_id: None,
            content: None,
            options: None,
            reason: None,
            error: Some(error.to_string()),
        },
    })
}

fn paths(base_path: &str) -> PersistencePaths {
    let base_path = PathBuf::from(base_path);
    PersistencePaths {
        sources_dir: base_path.join("translations"),
        meta_path: base_path.join("metadata.json"),
        checkpoint_path: base_path.join("backup-checkpoint.json"),
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

fn source_export_blocking(payload: SourceManagerPayload) -> Result<SourceImportExportResponse> {
    let paths = paths(&payload.persistence.base_path);
    let meta = load_meta(&paths);
    let mut export_data = serde_json::Map::new();
    for source_id in payload.source_ids {
        if let Some(source) = meta.pointer(&format!("/sources/{}", escape_pointer(&source_id))).cloned() {
            if let Some(content) = read_translation(&paths, &source_id) {
                export_data.insert(source_id, json!({ "meta": source, "content": content }));
            }
        }
    }
    let json_bytes = serde_json::to_vec(&Value::Object(export_data))?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&json_bytes)?;
    let compressed = encoder.finish()?;
    Ok(SourceImportExportResponse {
        state: true,
        content_base64: Some(BASE64_STANDARD.encode(compressed)),
        source: None,
        added_count: 0,
        updated_count: 0,
        skipped_count: 0,
        deleted_count: 0,
    })
}

fn source_read_blocking(payload: SourceManagerPayload) -> Result<SourceImportExportResponse> {
    let paths = paths(&payload.persistence.base_path);
    let source_id = payload.source_id.ok_or_else(|| anyhow!("sourceId missing"))?;
    let source = read_translation(&paths, &source_id).ok_or_else(|| anyhow!("翻译文件不存在"))?;
    Ok(SourceImportExportResponse {
        state: true,
        content_base64: None,
        source: Some(source),
        added_count: 0,
        updated_count: 0,
        skipped_count: 0,
        deleted_count: 0,
    })
}

fn source_import_blocking(payload: SourceManagerPayload) -> Result<SourceImportExportResponse> {
    let paths = paths(&payload.persistence.base_path);
    let encoded = payload.content_base64.ok_or_else(|| anyhow!("contentBase64 missing"))?;
    let bytes = BASE64_STANDARD.decode(encoded)?;
    let text = if payload.file_name.as_deref().is_some_and(|name| name.ends_with(".gz")) {
        let mut decoder = GzDecoder::new(bytes.as_slice());
        let mut output = String::new();
        decoder.read_to_string(&mut output)?;
        output
    } else {
        match String::from_utf8(bytes.clone()) {
            Ok(text) => text,
            Err(_) => {
                let mut decoder = GzDecoder::new(bytes.as_slice());
                let mut output = String::new();
                decoder.read_to_string(&mut output)?;
                output
            }
        }
    };
    let data: Value = serde_json::from_str(&text)?;
    let mut meta = load_meta(&paths);
    let sources = meta
        .get_mut("sources")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("metadata sources missing"))?;
    let mut added_count = 0usize;
    let mut updated_count = 0usize;
    let mut skipped_count = 0usize;

    if let Some(entries) = data.as_object() {
        for item in entries.values() {
            let Some(mut source) = item.get("meta").cloned() else { continue; };
            let Some(content) = item.get("content").cloned() else { continue; };
            let Some(source_id) = source.get("id").and_then(Value::as_str).map(str::to_string) else { continue; };
            let checksum = source.get("checksum").and_then(Value::as_str).unwrap_or_default().to_string();
            if let Some(existing) = sources.get(&source_id) {
                if existing.get("checksum").and_then(Value::as_str).unwrap_or_default() == checksum {
                    skipped_count += 1;
                    continue;
                }
                updated_count += 1;
            } else {
                added_count += 1;
            }
            let now = now_ms();
            if source.get("createdAt").and_then(Value::as_u64).unwrap_or(0) == 0 {
                source["createdAt"] = json!(now);
            }
            source["updatedAt"] = json!(now);
            merge_metadata_index(&mut source, &content, false);
            save_translation(&paths, &source_id, &content)?;
            merge_source_file_mtime(&mut source, &paths, &source_id);
            sources.insert(source_id, source);
        }
    }
    write_json_pretty(&paths.meta_path, &meta)?;
    Ok(SourceImportExportResponse {
        state: true,
        content_base64: None,
        source: None,
        added_count,
        updated_count,
        skipped_count,
        deleted_count: 0,
    })
}

fn source_remove_blocking(payload: SourceManagerPayload) -> Result<SourceImportExportResponse> {
    let paths = paths(&payload.persistence.base_path);
    let mut meta = load_meta(&paths);
    let mut deleted_count = 0usize;
    if let Some(sources) = meta.get_mut("sources").and_then(Value::as_object_mut) {
        for source_id in payload.source_ids {
            if let Some(source) = sources.remove(&source_id) {
                deleted_count += 1;
                let was_active = source.get("isActive").and_then(Value::as_bool).unwrap_or(false);
                let plugin_id = source.get("plugin").and_then(Value::as_str).unwrap_or_default().to_string();
                if was_active {
                    if let Some((_, replacement)) = sources
                        .iter_mut()
                        .find(|(_, item)| item.get("plugin").and_then(Value::as_str) == Some(plugin_id.as_str()))
                    {
                        replacement["isActive"] = json!(true);
                    }
                }
                match fs::remove_file(paths.sources_dir.join(format!("{source_id}.json"))) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }
    write_json_pretty(&paths.meta_path, &meta)?;
    Ok(SourceImportExportResponse {
        state: true,
        content_base64: None,
        source: None,
        added_count: 0,
        updated_count: 0,
        skipped_count: 0,
        deleted_count,
    })
}

fn source_set_active_blocking(payload: SourceManagerPayload) -> Result<SourceImportExportResponse> {
    let paths = paths(&payload.persistence.base_path);
    let source_id = payload.source_id.ok_or_else(|| anyhow!("sourceId missing"))?;
    let active = payload.active.unwrap_or(true);
    let mut meta = load_meta(&paths);
    if let Some(sources) = meta.get_mut("sources").and_then(Value::as_object_mut) {
        let plugin_id = sources
            .get(&source_id)
            .and_then(|source| source.get("plugin"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if !plugin_id.is_empty() {
            if active {
                for source in sources.values_mut() {
                    if source.get("plugin").and_then(Value::as_str) == Some(plugin_id.as_str()) {
                        source["isActive"] = json!(source.get("id").and_then(Value::as_str) == Some(source_id.as_str()));
                    }
                }
            } else if let Some(source) = sources.get_mut(&source_id) {
                source["isActive"] = json!(false);
            }
        }
    }
    write_json_pretty(&paths.meta_path, &meta)?;
    Ok(SourceImportExportResponse {
        state: true,
        content_base64: None,
        source: None,
        added_count: 0,
        updated_count: 0,
        skipped_count: 0,
        deleted_count: 0,
    })
}

fn source_clear_batch_records_blocking(payload: SourceManagerPayload) -> Result<SourceImportExportResponse> {
    let paths = paths(&payload.persistence.base_path);
    let scope = payload.scope.as_deref();
    let mut record = load_record(&paths);
    let mut deleted_count = 0usize;

    if let Some(checkpoints) = record.get_mut("checkpoints").and_then(Value::as_object_mut) {
        for key in &payload.checkpoint_keys {
            if checkpoints.remove(key).is_some() {
                deleted_count += 1;
            }
        }
        if payload.checkpoint_keys.is_empty() && scope.is_none() {
            deleted_count += checkpoints.len();
            checkpoints.clear();
        }
    }

    if let Some(scope) = scope {
        deleted_count += retain_record_array(&mut record, "failures", |item| {
            item.get("scope").and_then(Value::as_str) != Some(scope)
        });
        deleted_count += retain_record_array(&mut record, "successBatches", |item| {
            item.get("scope").and_then(Value::as_str) != Some(scope)
        });
    }

    save_record(&paths, record)?;
    Ok(SourceImportExportResponse {
        state: true,
        content_base64: None,
        source: None,
        added_count: 0,
        updated_count: 0,
        skipped_count: 0,
        deleted_count,
    })
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
        "successBatches": raw.get("successBatches").and_then(Value::as_array).cloned().unwrap_or_default(),
        "updatedAt": raw.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
    })
}

fn save_record(paths: &PersistencePaths, mut record: Value) -> Result<()> {
    record["updatedAt"] = json!(now_ms());
    write_json_pretty(&paths.batch_task_record_path, &record)
}

fn retain_record_array<F>(record: &mut Value, key: &str, mut keep: F) -> usize
where
    F: FnMut(&Value) -> bool,
{
    let existing = record
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let original_len = existing.len();
    let retained = existing.into_iter().filter(|item| keep(item)).collect::<Vec<_>>();
    let removed = original_len.saturating_sub(retained.len());
    record[key] = Value::Array(retained);
    removed
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

fn metadata_index(content: &Value) -> Value {
    let is_pending_translation = |item: &Value| {
        let source = item.get("source").and_then(Value::as_str).unwrap_or_default().trim();
        let target = item.get("target").and_then(Value::as_str).unwrap_or_default().trim();
        target.is_empty() || target == source
    };
    let is_translated_entry = |item: &Value| {
        let source = item.get("source").and_then(Value::as_str).unwrap_or_default().trim();
        let target = item.get("target").and_then(Value::as_str).unwrap_or_default().trim();
        !target.is_empty() && target != source
    };

    let (format_valid, total_count, pending_count, translated_count) = if let Some(dict) = content.get("dict") {
        if let Some(plugin_dict) = dict.as_object() {
            let mut total = 0u64;
            let mut pending = 0u64;
            let mut translated = 0u64;
            let mut valid = content.get("schemaVersion").is_some() && content.get("metadata").is_some();
            for group in plugin_dict.values() {
                let ast = group.get("ast").and_then(Value::as_array);
                let regex = group.get("regex").and_then(Value::as_array);
                if ast.is_none() || regex.is_none() {
                    valid = false;
                }
                for item in ast.into_iter().flatten().chain(regex.into_iter().flatten()) {
                    total += 1;
                    if is_pending_translation(item) {
                        pending += 1;
                    }
                    if is_translated_entry(item) {
                        translated += 1;
                    }
                }
            }
            (valid, total, pending, translated)
        } else if let Some(theme_items) = dict.as_array() {
            let total = theme_items.len() as u64;
            let pending = theme_items.iter().filter(|item| is_pending_translation(item)).count() as u64;
            let translated = theme_items.iter().filter(|item| is_translated_entry(item)).count() as u64;
            let valid = content.get("schemaVersion").is_some() && content.get("metadata").is_some();
            (valid, total, pending, translated)
        } else {
            (false, 0, 0, 0)
        }
    } else {
        (false, 0, 0, 0)
    };

    json!({
        "translationVersion": content.pointer("/metadata/version").and_then(Value::as_str).unwrap_or_default(),
        "supportedVersions": content.pointer("/metadata/supportedVersions").and_then(Value::as_str).unwrap_or_default(),
        "language": content.pointer("/metadata/language").and_then(Value::as_str).unwrap_or_default(),
        "description": content.pointer("/metadata/description").and_then(Value::as_str).unwrap_or_default(),
        "totalTranslationCount": total_count,
        "pendingTranslationCount": pending_count,
        "translatedEntryCount": translated_count,
        "processedTranslationCount": 0,
        "unprocessedTranslationCount": total_count,
        "translationProcessingComplete": false,
        "translationFormatValid": format_valid,
        "metadataIndexedAt": now_ms(),
    })
}

fn merge_metadata_index(source: &mut Value, content: &Value, preserve_processing_state: bool) {
    let index = metadata_index(content);
    if let Some(obj) = index.as_object() {
        for (key, value) in obj {
            if preserve_processing_state
                && matches!(
                key.as_str(),
                "processedTranslationCount" | "unprocessedTranslationCount" | "translationProcessingComplete"
            ) && source.get(key).is_some()
            {
                continue;
            }
            source[key] = value.clone();
        }
    }
}

fn merge_source_file_mtime(source: &mut Value, paths: &PersistencePaths, source_id: &str) {
    let file_path = paths.sources_dir.join(format!("{source_id}.json"));
    match fs::metadata(file_path) {
        Ok(metadata) => {
            let source_file_mtime = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_else(now_ms);
            source["sourceFileExists"] = json!(true);
            source["sourceFileMtime"] = json!(source_file_mtime);
        }
        Err(_) => {
            source["sourceFileExists"] = json!(false);
            source["sourceFileMtime"] = json!(0);
        }
    }
}

fn installed_resource_sets(state: &AppState) -> (HashSet<String>, HashSet<String>) {
    let Ok(obsidian_dir) = obsidian_dir(state) else {
        return (HashSet::new(), HashSet::new());
    };

    let mut plugins = HashSet::new();
    let plugins_dir = obsidian_dir.join("plugins");
    if let Ok(entries) = fs::read_dir(&plugins_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|item| item.is_dir()).unwrap_or(false) {
                let plugin_id = read_json_file(&entry.path().join("manifest.json"))
                    .and_then(|manifest| manifest.get("id").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_else(|| entry.file_name().to_string_lossy().to_string());
                plugins.insert(plugin_id);
            }
        }
    }

    let mut themes = HashSet::new();
    let themes_dir = obsidian_dir.join("themes");
    if let Ok(entries) = fs::read_dir(&themes_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().map(|item| item.is_dir()).unwrap_or(false) {
                themes.insert(name);
            } else if entry.file_type().map(|item| item.is_file()).unwrap_or(false)
                && entry.path().extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("css"))
            {
                if let Some(stem) = entry.path().file_stem().and_then(|stem| stem.to_str()) {
                    themes.insert(stem.to_string());
                }
            }
        }
    }

    (plugins, themes)
}

fn merge_source_install_state(source: &mut Value, installed_plugins: &HashSet<String>, installed_themes: &HashSet<String>) {
    let plugin_id = source.get("plugin").and_then(Value::as_str).unwrap_or_default();
    let source_type = source.get("type").and_then(Value::as_str).unwrap_or("plugin");
    let is_installed = if source_type == "theme" {
        installed_themes.contains(plugin_id)
    } else {
        installed_plugins.contains(plugin_id)
    };
    source["isInstalled"] = json!(is_installed);
}

fn source_index_blocking(state: &AppState, payload: SourceManagerPayload) -> Result<SourceImportExportResponse> {
    let paths = paths(&payload.persistence.base_path);
    let mut meta = load_meta(&paths);
    let mut updated_count = 0usize;
    let mut skipped_count = 0usize;
    let (installed_plugins, installed_themes) = installed_resource_sets(state);

    if let Some(sources) = meta.get_mut("sources").and_then(Value::as_object_mut) {
        let source_ids: Vec<String> = if payload.source_ids.is_empty() {
            sources.keys().cloned().collect()
        } else {
            payload.source_ids
        };

        for source_id in source_ids {
            let Some(source) = sources.get_mut(&source_id) else {
                skipped_count += 1;
                continue;
            };
            let file_path = paths.sources_dir.join(format!("{source_id}.json"));
            let Ok(metadata) = fs::metadata(&file_path) else {
                source["sourceFileExists"] = json!(false);
                source["sourceFileMtime"] = json!(0);
                merge_source_install_state(source, &installed_plugins, &installed_themes);
                updated_count += 1;
                skipped_count += 1;
                continue;
            };
            let source_file_mtime = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_else(now_ms);
            let Some(content) = read_translation(&paths, &source_id) else {
                source["sourceFileExists"] = json!(false);
                source["sourceFileMtime"] = json!(0);
                merge_source_install_state(source, &installed_plugins, &installed_themes);
                updated_count += 1;
                skipped_count += 1;
                continue;
            };
            merge_metadata_index(source, &content, true);
            source["sourceFileExists"] = json!(true);
            source["sourceFileMtime"] = json!(source_file_mtime);
            merge_source_install_state(source, &installed_plugins, &installed_themes);
            updated_count += 1;
        }
    }

    if updated_count > 0 {
        write_json_pretty(&paths.meta_path, &meta)?;
    }

    Ok(SourceImportExportResponse {
        state: true,
        content_base64: None,
        source: None,
        added_count: 0,
        updated_count,
        skipped_count,
        deleted_count: 0,
    })
}

#[derive(Debug, Clone, Copy)]
struct SavedTranslationIndex {
    total_count: u64,
    format_valid: bool,
}

#[derive(Debug, Clone, Copy)]
struct SourceProcessingState {
    complete: bool,
    processed_count: u64,
    unprocessed_count: u64,
}

async fn save_translated_source(
    state: &AppState,
    paths: &PersistencePaths,
    source_id: &str,
    content: &Value,
) -> Result<SavedTranslationIndex> {
    save_translated_source_with_processing_preservation(state, paths, source_id, content, false).await
}

async fn save_translated_source_partial(
    state: &AppState,
    paths: &PersistencePaths,
    source_id: &str,
    content: &Value,
) -> Result<SavedTranslationIndex> {
    save_translated_source_with_processing_preservation(state, paths, source_id, content, true).await
}

async fn save_translated_source_with_processing_preservation(
    state: &AppState,
    paths: &PersistencePaths,
    source_id: &str,
    content: &Value,
    preserve_processing_state: bool,
) -> Result<SavedTranslationIndex> {
    let _guard = state.persistence_lock.lock().await;
    let mut meta = load_meta(paths);
    save_translation(paths, source_id, content)?;
    let mut saved_index = SavedTranslationIndex {
        total_count: 0,
        format_valid: false,
    };
    let active_scope = {
        let Some(source) = meta.pointer_mut(&format!("/sources/{source_id}")) else {
            return Ok(saved_index);
        };
        let plugin = source.get("plugin").and_then(Value::as_str).unwrap_or_default().to_string();
        let source_type = source.get("type").and_then(Value::as_str).unwrap_or("plugin").to_string();
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
        merge_metadata_index(source, content, preserve_processing_state);
        saved_index = SavedTranslationIndex {
            total_count: source.get("totalTranslationCount").and_then(Value::as_u64).unwrap_or(0),
            format_valid: source.get("translationFormatValid").and_then(Value::as_bool).unwrap_or(false),
        };
        merge_source_file_mtime(source, paths, source_id);
        if let Some(obj) = source.as_object_mut() {
            obj.remove("cloud");
            obj.insert(
                "checksum".to_string(),
                Value::String(calculate_checksum(content)?),
            );
            obj.insert("updatedAt".to_string(), json!(now_ms()));
        }
        (plugin, source_type)
    };
    let (plugin, source_type) = active_scope;
    if let Some(sources) = meta.get_mut("sources").and_then(Value::as_object_mut) {
        for existing in sources.values_mut() {
            if existing.get("plugin").and_then(Value::as_str) == Some(plugin.as_str())
                && existing.get("type").and_then(Value::as_str).unwrap_or("plugin") == source_type
            {
                existing["isActive"] = json!(existing.get("id").and_then(Value::as_str) == Some(source_id));
            }
        }
    }
    write_json_pretty(&paths.meta_path, &meta)?;
    Ok(saved_index)
}

async fn save_extracted_source(
    state: &AppState,
    paths: &PersistencePaths,
    plugin_id: &str,
    content: &Value,
    title: &str,
    source_type: &str,
) -> Result<bool> {
    let _guard = state.persistence_lock.lock().await;
    let mut meta = load_meta(paths);
    let source_id = nanoid!(32);
    let translation_version = content.pointer("/metadata/version").and_then(Value::as_str).unwrap_or_default();
    if let Some(sources) = meta.get_mut("sources").and_then(Value::as_object_mut) {
        if sources.values().any(|source| {
            source.get("plugin").and_then(Value::as_str) == Some(plugin_id)
                && source.get("type").and_then(Value::as_str) == Some(source_type)
                && source.get("translationVersion").and_then(Value::as_str) == Some(translation_version)
                && source
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|existing_source_id| paths.sources_dir.join(format!("{existing_source_id}.json")).exists())
        }) {
            return Ok(false);
        }
        for source in sources.values_mut() {
            if source.get("plugin").and_then(Value::as_str) == Some(plugin_id) {
                source["isActive"] = json!(false);
            }
        }
        let mut source = json!({
            "id": source_id,
            "plugin": plugin_id,
            "title": title,
            "type": source_type,
            "origin": "local",
            "isActive": true,
            "checksum": calculate_checksum(content)?,
            "createdAt": now_ms(),
            "updatedAt": now_ms(),
        });
        save_translation(paths, &source_id, content)?;
        merge_metadata_index(&mut source, content, false);
        merge_source_file_mtime(&mut source, paths, &source_id);
        sources.insert(source_id.clone(), source);
    }
    write_json_pretty(&paths.meta_path, &meta)?;
    Ok(true)
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

fn collect_failure_retry_window(
    failures: &[BatchTaskFailureRecord],
    item_limit: usize,
) -> Vec<BatchTaskFailureRecord> {
    let item_limit = item_limit.max(1);
    let mut collected = Vec::new();
    let mut collected_items = 0usize;

    for failure in failures {
        if failure.items.is_empty() {
            collected.push(failure.clone());
            continue;
        }
        if collected_items >= item_limit {
            break;
        }
        let remaining = item_limit - collected_items;
        let take_count = failure.items.len().min(remaining);
        let mut sliced = failure.clone();
        sliced.items = failure.items.iter().take(take_count).cloned().collect();
        collected_items += sliced.items.len();
        collected.push(sliced);
    }

    collected
}

fn retry_completed_item_key_from_value(value: &Value) -> RetryCompletedItemKey {
    RetryCompletedItemKey {
        failure_id: value
            .get("failureId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        dict_index: value.get("dictIndex").and_then(Value::as_i64).unwrap_or(-1) as isize,
        file: non_empty_string(value.get("file")),
        batch_type: value
            .get("batchType")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

fn remove_completed_retry_items_from_record(
    record: &mut Value,
    scope: &str,
    completed_items: &[RetryCompletedItemKey],
) -> Vec<String> {
    if completed_items.is_empty() {
        return Vec::new();
    }
    let completed: HashSet<RetryCompletedItemKey> = completed_items.iter().cloned().collect();
    let existing = record
        .get("failures")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut retained_failures = Vec::new();
    let mut removed_failure_ids = Vec::new();

    for mut failure in existing {
        let failure_scope = failure
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let failure_id = failure
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let batch_type = failure
            .get("batchType")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if failure_scope != scope {
            retained_failures.push(failure);
            continue;
        }

        let items = failure
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| {
                let key = RetryCompletedItemKey {
                    failure_id: failure_id.clone(),
                    dict_index: item.get("dictIndex").and_then(Value::as_i64).unwrap_or(-1) as isize,
                    file: non_empty_string(item.get("file")),
                    batch_type: batch_type.clone(),
                };
                !completed.contains(&key)
            })
            .collect::<Vec<_>>();
        if !items.is_empty() {
            failure["items"] = Value::Array(items);
            retained_failures.push(failure);
        } else {
            removed_failure_ids.push(failure_id);
        }
    }

    record["failures"] = Value::Array(retained_failures);
    removed_failure_ids
}

fn load_retry_failures_for_scope(paths: &PersistencePaths, scope: &str) -> Vec<BatchTaskFailureRecord> {
    load_record(paths)
        .get("failures")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|failure| serde_json::from_value::<BatchTaskFailureRecord>(failure).ok())
        .filter(|failure| failure.scope == scope && !failure.items.is_empty())
        .collect()
}

fn retry_completed_item_key_from_failure_item(
    failure: &BatchTaskFailureRecord,
    item: &BatchTaskFailureItem,
) -> RetryCompletedItemKey {
    RetryCompletedItemKey {
        failure_id: failure.id.clone(),
        dict_index: item.dict_index,
        file: item.file.clone(),
        batch_type: failure.batch_type.clone(),
    }
}

fn prune_retry_window_from_queue(
    queue: &mut Vec<BatchTaskFailureRecord>,
    window: &[BatchTaskFailureRecord],
) {
    let processed = window
        .iter()
        .flat_map(|failure| {
            failure
                .items
                .iter()
                .map(|item| retry_completed_item_key_from_failure_item(failure, item))
        })
        .collect::<HashSet<_>>();
    if processed.is_empty() {
        return;
    }

    let mut retained = Vec::new();
    for mut failure in queue.drain(..) {
        let failure_id = failure.id.clone();
        let batch_type = failure.batch_type.clone();
        failure.items.retain(|item| {
            !processed.contains(&RetryCompletedItemKey {
                failure_id: failure_id.clone(),
                dict_index: item.dict_index,
                file: item.file.clone(),
                batch_type: batch_type.clone(),
            })
        });
        if !failure.items.is_empty() {
            retained.push(failure);
        }
    }
    *queue = retained;
}

fn apply_retry_updates_to_translation(
    translation_json: &mut Value,
    updates: &[Value],
    is_plugin: bool,
) {
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
            if let Some(slot) = translation_json.pointer_mut(&format!("/dict/{}/target", index)) {
                *slot = update
                    .get("target")
                    .cloned()
                    .unwrap_or(Value::String(String::new()));
            }
        }
    }
}

async fn replace_or_clear_completed_failures_for_source(
    state: &AppState,
    paths: &PersistencePaths,
    scope: &str,
    source_id: &str,
    all_items: Vec<String>,
    pending_items: Vec<String>,
    overwrite_existing: bool,
    failures: Vec<CompanionBatchFailure>,
    success_items: Vec<String>,
) -> Result<SourceProcessingState> {
    let mut processing_state = SourceProcessingState {
        complete: false,
        processed_count: 0,
        unprocessed_count: all_items.len() as u64,
    };
    update_record(state, paths, |record| {
        let historical_success = record
            .get("successBatches")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| {
                item.get("scope").and_then(Value::as_str) == Some(scope)
                    && item.get("sourceId").and_then(Value::as_str) == Some(source_id)
            })
            .flat_map(|item| {
                item.get("itemKeys")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
            })
            .filter_map(|item| item.as_str().map(str::to_string));
        let mut combined_success = historical_success.chain(success_items).collect::<Vec<_>>();
        combined_success.sort_unstable();
        combined_success.dedup();
        let success_set: HashSet<&str> = combined_success.iter().map(String::as_str).collect();
        let required_items = if overwrite_existing {
            all_items.as_slice()
        } else {
            pending_items.as_slice()
        };
        let unprocessed_count = required_items
            .iter()
            .filter(|item| !success_set.contains(item.as_str()))
            .count() as u64;
        let resource_completed = failures.is_empty() && unprocessed_count == 0;
        processing_state = SourceProcessingState {
            complete: resource_completed,
            processed_count: all_items.len().saturating_sub(unprocessed_count as usize) as u64,
            unprocessed_count,
        };

        let mut existing_failures = record
            .get("failures")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        existing_failures.retain(|item| {
            !(item.get("scope").and_then(Value::as_str) == Some(scope)
                && item.get("sourceId").and_then(Value::as_str) == Some(source_id))
        });
        if !resource_completed {
            for failure in failures.into_iter().rev() {
                existing_failures.insert(
                    0,
                    serde_json::to_value(build_failure_record(scope, failure)).unwrap_or(Value::Null),
                );
            }
        }
        existing_failures.truncate(500);
        record["failures"] = Value::Array(existing_failures);

        let mut success_batches = record
            .get("successBatches")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        success_batches.retain(|item| {
            !(item.get("scope").and_then(Value::as_str) == Some(scope)
                && item.get("sourceId").and_then(Value::as_str) == Some(source_id))
        });
        if !resource_completed && !combined_success.is_empty() {
            success_batches.insert(0, json!({
                "scope": scope,
                "sourceId": source_id,
                "itemKeys": combined_success,
                "updatedAt": now_ms(),
            }));
            success_batches.truncate(500);
        }
        record["successBatches"] = Value::Array(success_batches);
    })
    .await?;
    Ok(processing_state)
}

async fn update_source_processing_state(
    state: &AppState,
    paths: &PersistencePaths,
    source_id: &str,
    processing_state: SourceProcessingState,
) -> Result<()> {
    let _guard = state.persistence_lock.lock().await;
    let mut meta = load_meta(paths);
    if let Some(source) = meta.pointer_mut(&format!("/sources/{source_id}")) {
        source["processedTranslationCount"] = json!(processing_state.processed_count);
        source["unprocessedTranslationCount"] = json!(processing_state.unprocessed_count);
        source["translationProcessingComplete"] = json!(processing_state.complete);
        source["updatedAt"] = json!(now_ms());
        write_json_pretty(&paths.meta_path, &meta)?;
    }
    Ok(())
}

async fn update_retry_source_processing_state(
    state: &AppState,
    paths: &PersistencePaths,
    scope: &str,
    source_id: &str,
) -> Result<SourceProcessingState> {
    let _guard = state.persistence_lock.lock().await;
    let record = load_record(paths);
    let remaining_failures = record
        .get("failures")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let unprocessed_count = remaining_failures
        .iter()
        .filter(|failure| {
            failure.get("scope").and_then(Value::as_str) == Some(scope)
                && failure.get("sourceId").and_then(Value::as_str) == Some(source_id)
        })
        .flat_map(|failure| {
            failure
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .count() as u64;

    let mut meta = load_meta(paths);
    let Some(source) = meta.pointer_mut(&format!("/sources/{source_id}")) else {
        return Ok(SourceProcessingState {
            complete: false,
            processed_count: 0,
            unprocessed_count,
        });
    };
    let total_count = source
        .get("totalTranslationCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let processing_state = SourceProcessingState {
        complete: total_count > 0 && unprocessed_count == 0,
        processed_count: total_count.saturating_sub(unprocessed_count),
        unprocessed_count,
    };
    source["processedTranslationCount"] = json!(processing_state.processed_count);
    source["unprocessedTranslationCount"] = json!(processing_state.unprocessed_count);
    source["translationProcessingComplete"] = json!(processing_state.complete);
    source["updatedAt"] = json!(now_ms());
    write_json_pretty(&paths.meta_path, &meta)?;
    Ok(processing_state)
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
    let batch_language = batch.language.clone();
    let batch_settings = serde_json::to_value(&batch.settings)?;
    let batch_translation_version = if batch.translation_version.is_empty() {
        batch.settings.translation_version.clone()
    } else {
        batch.translation_version.clone()
    };
    let completed = Arc::new(Mutex::new(HashSet::<usize>::new()));
    let semaphore = Arc::new(Semaphore::new(
        batch.concurrency.max(1).min(MAX_EXTRACT_CPU_CONCURRENCY),
    ));
    let resources = Arc::new(batch.resources.clone());
    let last_checkpoint_at = Arc::new(Mutex::new(now_ms()));
    let mut handles = Vec::new();

    for (index, resource) in batch.resources.into_iter().enumerate() {
        ensure_not_cancelled(&task).await?;
        let permit = semaphore.clone().acquire_owned().await?;
        let state = state.clone();
        let task = task.clone();
        let paths = paths.clone();
        let completed = completed.clone();
        let resources = resources.clone();
        let last_checkpoint_at = last_checkpoint_at.clone();
        let checkpoint_key = batch.checkpoint_key.clone();
        let batch_language = batch_language.clone();
        let batch_settings = batch_settings.clone();
        let batch_translation_version = batch_translation_version.clone();
        let scope = scope.to_string();
        let mode = mode.to_string();
        handles.push(tokio::spawn(async move {
            let _permit = permit;
            if !is_task_active(&task).await {
                return Ok::<(), anyhow::Error>(());
            }
            let mut resource = resource;
            let resource_id = resource
                .get("resourceId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if has_existing_extracted_source(
                &paths,
                &resource_id,
                if scope == "theme" { "theme" } else { "plugin" },
                &batch_translation_version,
            ) {
                completed.lock().await.insert(index);
                increment_progress(&task, "processedResources", 1).await;
                increment_progress(&task, "skippedCount", 1).await;
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
                return Ok::<(), anyhow::Error>(());
            }
            if let Some(object) = resource.as_object_mut() {
                if !object.contains_key("settings") {
                    object.insert("settings".to_string(), batch_settings.clone());
                }
                if scope == "plugin" && !object.contains_key("language") && !batch_language.is_empty() {
                    object.insert("language".to_string(), Value::String(batch_language.clone()));
                }
            }
            let label = resource
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            touch_progress(&task, json!({ "currentLabel": label })).await;
            let result = if scope == "plugin" {
                handle_plugin_extract(resource).await
            } else {
                handle_theme_extract(resource).await
            };
            match result {
                Ok(result) if result.status == "success" => {
                    let plugin_id = result.plugin_id.as_deref().unwrap_or_default();
                    let title = result
                        .options
                        .as_ref()
                        .and_then(|options| options.get("title"))
                        .and_then(Value::as_str)
                        .unwrap_or(plugin_id);
                    let source_type = result
                        .options
                        .as_ref()
                        .and_then(|options| options.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or("plugin");
                    let content = result.content.unwrap_or(Value::Null);
                    if save_extracted_source(&state, &paths, plugin_id, &content, title, source_type).await? {
                        bump_source_revision(&task).await;
                        increment_progress(&task, "successCount", 1).await;
                    } else {
                        increment_progress(&task, "skippedCount", 1).await;
                    }
                }
                Ok(result) if result.status == "skipped" => {
                    increment_progress(&task, "skippedCount", 1).await;
                }
                Ok(result) => {
                    eprintln!(
                        "[i18n] Failed to batch extract: {}",
                        result.error.as_deref().unwrap_or("unknown")
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
            let should_save_checkpoint = progress.processed_resources == progress.total_resources
                || progress.processed_resources % EXTRACT_CHECKPOINT_EVERY_RESOURCES == 0
                || {
                    let mut last_checkpoint_at = last_checkpoint_at.lock().await;
                    let now = now_ms();
                    if now.saturating_sub(*last_checkpoint_at) >= EXTRACT_CHECKPOINT_EVERY_MS {
                        *last_checkpoint_at = now;
                        true
                    } else {
                        false
                    }
                };
            if should_save_checkpoint {
                let completed_set = completed.lock().await.clone();
                save_checkpoint(
                    &state,
                    &paths,
                    &checkpoint_key,
                    create_checkpoint(&scope, &mode, &resources, &completed_set, &progress),
                )
                .await?;
                bump_record_revision(&task).await;
            }
            Ok(())
        }));
    }

    for handle in handles {
        if *task.cancel_requested.lock().await {
            break;
        }
        handle.await??;
    }
    if *task.cancel_requested.lock().await {
        let progress = task.progress.lock().await.clone();
        let completed_set = completed.lock().await.clone();
        save_checkpoint(
            state,
            &paths,
            &batch.checkpoint_key,
            create_checkpoint(scope, mode, &resources, &completed_set, &progress),
        )
        .await?;
        bump_record_revision(&task).await;
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
    let window_item_limit = translate_window_item_limit(
        batch.config.batch_size,
        batch.config.concurrency,
        batch.config.batch_window_multiplier,
    );
    let mut next_resource_index = 0usize;

    while next_resource_index < batch.resources.len() {
        if let Err(error) = ensure_not_cancelled(&task).await {
            save_batch_translate_checkpoint(
                state,
                &paths,
                &batch.checkpoint_key,
                scope,
                &resources_value,
                &completed,
                &task,
            )
            .await?;
            return Err(error);
        }
        let mut resource_states = Vec::<BatchResourceState>::new();
        let mut ast_items = Vec::<Value>::new();
        let mut regex_items = Vec::<Value>::new();
        let mut theme_items = Vec::<Value>::new();
        let mut pending_items_in_window = 0usize;
        let mut ast_id = 0u64;
        let mut regex_id = 0u64;
        let mut theme_id = 0u64;

        while next_resource_index < batch.resources.len()
            && (resource_states.is_empty() || pending_items_in_window < window_item_limit)
        {
            let index = next_resource_index;
            next_resource_index += 1;
            let resource = batch.resources[index].clone();
            if let Err(error) = ensure_not_cancelled(&task).await {
                save_batch_translate_checkpoint(
                    state,
                    &paths,
                    &batch.checkpoint_key,
                    scope,
                    &resources_value,
                    &completed,
                    &task,
                )
                .await?;
                return Err(error);
            }
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
                count_pending_plugin_items(&translation_json, batch.config.overwrite_existing_translations)
            } else {
                count_pending_theme_items(&translation_json, batch.config.overwrite_existing_translations)
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
            let mut resource_state = BatchResourceState {
                original_index: index,
                resource,
                source_id,
                translation_json,
                processed_items: 0,
                dirty: false,
                all_items: Vec::new(),
                pending_items: Vec::new(),
                success_items: Vec::new(),
                failures: Vec::new(),
            };
            let before_ast_items = ast_items.len();
            let before_regex_items = regex_items.len();
            let before_theme_items = theme_items.len();
            if is_plugin {
                collect_plugin_packed_items(
                    state_index,
                    &resource_state,
                    batch.config.overwrite_existing_translations,
                    &mut ast_id,
                    &mut regex_id,
                    &mut ast_items,
                    &mut regex_items,
                );
            } else {
                collect_theme_packed_items(
                    state_index,
                    &resource_state,
                    batch.config.overwrite_existing_translations,
                    &mut theme_id,
                    &mut theme_items,
                );
            }
            let added_items = ast_items.len() + regex_items.len() + theme_items.len()
                - before_ast_items - before_regex_items - before_theme_items;
            if added_items == 0 {
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
            resource_state.all_items = collect_all_item_keys(&resource_state.translation_json, is_plugin);
            resource_state.pending_items = if is_plugin {
                ast_items[before_ast_items..].iter()
                    .map(|item| compact_success_item_key(item, "ast", true))
                    .chain(regex_items[before_regex_items..].iter().map(|item| compact_success_item_key(item, "regex", true)))
                    .collect()
            } else {
                theme_items[before_theme_items..].iter().map(|item| compact_success_item_key(item, "theme", false)).collect()
            };
            pending_items_in_window += added_items;
            resource_states.push(resource_state);
        }

        if resource_states.is_empty() {
            continue;
        }

        let window_result = process_batch_translate_window(
            state,
            &task,
            &paths,
            &batch,
            scope,
            &resources_value,
            &mut completed,
            resource_states,
            ast_items,
            regex_items,
            theme_items,
            is_plugin,
        )
        .await;
        if let Err(error) = window_result {
            if error.to_string().contains(MANUAL_STOP) {
                save_batch_translate_checkpoint(
                    state,
                    &paths,
                    &batch.checkpoint_key,
                    scope,
                    &resources_value,
                    &completed,
                    &task,
                )
                .await?;
            }
            return Err(error);
        }
    }

    if *task.cancel_requested.lock().await {
        return Ok(());
    }
    clear_checkpoint(state, &paths, &batch.checkpoint_key).await?;
    bump_record_revision(&task).await;
    Ok(())
}

async fn save_batch_translate_checkpoint(
    state: &AppState,
    paths: &PersistencePaths,
    checkpoint_key: &str,
    scope: &str,
    resources: &[Value],
    completed: &HashSet<usize>,
    task: &TaskRuntime,
) -> Result<()> {
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

async fn process_batch_translate_window(
    state: &AppState,
    task: &Arc<TaskRuntime>,
    paths: &PersistencePaths,
    batch: &PluginBatchTranslatePayload,
    scope: &str,
    resources_value: &[Value],
    completed: &mut HashSet<usize>,
    mut resource_states: Vec<BatchResourceState>,
    ast_items: Vec<Value>,
    regex_items: Vec<Value>,
    theme_items: Vec<Value>,
    is_plugin: bool,
) -> Result<()> {
    let mut failed_items_in_window = 0usize;
    let mut stop_error: Option<anyhow::Error> = None;

    if is_plugin {
        touch_progress(task, json!({ "currentLabel": "AST" })).await;
        let ast_report = translate_packed_batches(
            &ast_items,
            &mut resource_states,
            &batch.config.prompts.ast,
            &batch.config,
            |item| json!({ "i": item["id"], "s": item["source"], "y": item["type"], "n": item["name"] }),
            PackedBatchRuntime {
                state,
                paths,
                batch_type: "ast",
                is_plugin: true,
                flush_every_batches: batch.config.concurrency,
            },
            Some(task.clone()),
        )
        .await?;
        failed_items_in_window += packed_report_failed_item_count(&ast_report);
        if let Err(error) = stop_if_batch_translate_failures_exceed_limit(
            failed_items_in_window,
            &batch.config,
            "AST",
        ) {
            stop_error = Some(error);
        }

        if stop_error.is_none() {
            touch_progress(task, json!({ "currentLabel": "Regex" })).await;
            let regex_report = translate_packed_batches(
                &regex_items,
                &mut resource_states,
                &batch.config.prompts.regex,
                &batch.config,
                |item| json!({ "i": item["id"], "s": item["source"] }),
                PackedBatchRuntime {
                    state,
                    paths,
                    batch_type: "regex",
                    is_plugin: true,
                    flush_every_batches: batch.config.concurrency,
                },
                Some(task.clone()),
            )
            .await?;
            failed_items_in_window += packed_report_failed_item_count(&regex_report);
            if let Err(error) = stop_if_batch_translate_failures_exceed_limit(
                failed_items_in_window,
                &batch.config,
                "Regex",
            ) {
                stop_error = Some(error);
            }
        }
    } else {
        touch_progress(task, json!({ "currentLabel": "Theme" })).await;
        let theme_report = translate_packed_batches(
            &theme_items,
            &mut resource_states,
            &batch.config.prompts.theme,
            &batch.config,
            |item| json!({ "i": item["id"], "s": item["source"], "y": item["type"] }),
            PackedBatchRuntime {
                state,
                paths,
                batch_type: "theme",
                is_plugin: false,
                flush_every_batches: batch.config.concurrency,
            },
            Some(task.clone()),
        )
        .await?;
        failed_items_in_window += packed_report_failed_item_count(&theme_report);
        if let Err(error) = stop_if_batch_translate_failures_exceed_limit(
            failed_items_in_window,
            &batch.config,
            "Theme",
        ) {
            stop_error = Some(error);
        }
    }

    for resource_state in resource_states {
        ensure_not_cancelled(task).await?;
        touch_progress(task, json!({ "currentLabel": resource_state.resource.label })).await;
        let saved_index = save_translated_source(
            state,
            paths,
            &resource_state.source_id,
            &resource_state.translation_json,
        )
        .await?;
        let processing_state = replace_or_clear_completed_failures_for_source(
            state,
            paths,
            scope,
            &resource_state.source_id,
            resource_state.all_items,
            resource_state.pending_items,
            batch.config.overwrite_existing_translations,
            resource_state.failures,
            resource_state.success_items,
        )
        .await?;
        update_source_processing_state(state, paths, &resource_state.source_id, processing_state)
            .await?;
        if saved_index.format_valid && saved_index.total_count > 0 && processing_state.complete {
            increment_progress(task, "successCount", 1).await;
        } else {
            increment_progress(task, "failedCount", 1).await;
        }
        mark_batch_translate_resource_completed(
            state,
            task,
            paths,
            &batch.checkpoint_key,
            scope,
            resources_value,
            completed,
            resource_state.original_index,
            false,
        )
        .await?;
        bump_source_revision(task).await;
    }

    if let Some(error) = stop_error {
        return Err(error);
    }

    Ok(())
}

fn translate_window_item_limit(batch_size: usize, concurrency: usize, window_multiplier: usize) -> usize {
    batch_size.max(1) * concurrency.max(1) * window_multiplier.max(1)
}

fn failed_item_stop_threshold(batch_size: usize, concurrency: usize) -> usize {
    batch_size.max(1) * concurrency.max(1)
}

fn should_stop_batch_translate_for_failures(
    failed_items: usize,
    batch_size: usize,
    concurrency: usize,
) -> bool {
    failed_items >= failed_item_stop_threshold(batch_size, concurrency)
}

#[derive(Debug, Clone)]
struct BatchResourceState {
    original_index: usize,
    resource: CompanionBatchResource,
    source_id: String,
    translation_json: Value,
    processed_items: usize,
    dirty: bool,
    all_items: Vec<String>,
    pending_items: Vec<String>,
    success_items: Vec<String>,
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

struct PackedBatchRuntime<'a> {
    state: &'a AppState,
    paths: &'a PersistencePaths,
    batch_type: &'a str,
    is_plugin: bool,
    flush_every_batches: usize,
}

fn packed_report_failed_item_count(report: &PackedBatchReport) -> usize {
    report
        .failures
        .iter()
        .map(|failure| failure.items.len())
        .sum()
}

fn stop_if_batch_translate_failures_exceed_limit(
    failed_items: usize,
    config: &CompanionTranslationConfig,
    phase: &str,
) -> Result<()> {
    if !should_stop_batch_translate_for_failures(failed_items, config.batch_size, config.concurrency) {
        return Ok(());
    }
    bail!(
        "批量翻译失败条目达到熔断阈值，已停止本次任务（阶段：{}，失败条目：{}，阈值：{} = 每批次条目数 {} × 请求并发数 {}）",
        phase,
        failed_items,
        failed_item_stop_threshold(config.batch_size, config.concurrency),
        config.batch_size.max(1),
        config.concurrency.max(1)
    )
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
    overwrite_existing: bool,
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
                    if should_translate(item.get("target"), item.get("source"), overwrite_existing) {
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
                    if should_translate(item.get("target"), item.get("source"), overwrite_existing) {
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
    overwrite_existing: bool,
    theme_id: &mut u64,
    theme_items: &mut Vec<Value>,
) {
    if let Some(dict) = resource_state
        .translation_json
        .get("dict")
        .and_then(Value::as_array)
    {
        for (index, item) in dict.iter().enumerate() {
            if should_translate(item.get("target"), item.get("source"), overwrite_existing) {
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

fn collect_all_item_keys(translation_json: &Value, is_plugin: bool) -> Vec<String> {
    let mut keys = Vec::new();
    if is_plugin {
        if let Some(dict) = translation_json.get("dict").and_then(Value::as_object) {
            for (file, file_dict) in dict {
                if let Some(ast) = file_dict.get("ast").and_then(Value::as_array) {
                    keys.extend((0..ast.len()).map(|index| format!("{file}\tast\t{index}")));
                }
                if let Some(regex) = file_dict.get("regex").and_then(Value::as_array) {
                    keys.extend((0..regex.len()).map(|index| format!("{file}\tregex\t{index}")));
                }
            }
        }
    } else if let Some(dict) = translation_json.get("dict").and_then(Value::as_array) {
        keys.extend((0..dict.len()).map(|index| index.to_string()));
    }
    keys
}

async fn translate_packed_batches<F>(
    items: &[Value],
    resource_states: &mut [BatchResourceState],
    prompt: &str,
    config: &CompanionTranslationConfig,
    simplify: F,
    runtime: PackedBatchRuntime<'_>,
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

    let batches = split_translation_batches(items, config.batch_size, config.batch_char_limit);
    let concurrency = config.concurrency.max(1).min(batches.len().max(1));
    let mut handles = JoinSet::new();
    let mut next_batch = 0usize;
    let mut completed_since_flush = 0usize;
    let flush_every_batches = runtime.flush_every_batches.max(1);
    let mut failed_items = 0usize;
    let mut stop_scheduling = false;

    while next_batch < batches.len() && handles.len() < concurrency {
        if let Some(task) = &task {
            ensure_not_cancelled(task).await?;
        }
        let batch = batches[next_batch].clone();
        next_batch += 1;
        let simplified: Vec<Value> = batch.iter().map(&simplify).collect();
        let prompt = prompt.to_string();
        let config = config.clone();
        let task = task.clone();
        handles.spawn(async move {
            if let Some(task) = &task {
                ensure_not_cancelled(task).await?;
            }
            let result = call_chat_completion(&simplified, &prompt, &config).await;
            if let Some(task) = &task {
                ensure_not_cancelled(task).await?;
            }
            Ok::<_, anyhow::Error>((batch, result))
        });
    }

    while let Some(handle) = handles.join_next().await {
        if let Some(task) = &task {
            ensure_not_cancelled(task).await?;
        }
        let (batch, result) = handle??;
        if let Some(task) = &task {
            increment_progress(task, "processedItems", batch.len()).await;
        }
        completed_since_flush += 1;

        match result {
            Ok(translated) => {
                let batch_report = packed_batch_report(batch, translated);
                let failed_count = packed_report_failed_item_count(&batch_report);
                failed_items += failed_count;
                apply_packed_translation_report(
                    resource_states,
                    batch_report.clone(),
                    runtime.batch_type,
                    runtime.is_plugin,
                );
                report.translated_items.extend(batch_report.translated_items);
                report.failures.extend(batch_report.failures);
                if failed_count > 0 {
                    flush_changed_resource_states(runtime.state, runtime.paths, resource_states).await?;
                }
                if should_stop_batch_translate_for_failures(failed_items, config.batch_size, config.concurrency) {
                    stop_scheduling = true;
                }
            }
            Err(error) if error.to_string().contains(MANUAL_STOP) => return Err(error),
            Err(error) => {
                let batch_failed_count = batch.len();
                let mut grouped = HashMap::<usize, Vec<BatchTaskFailureItem>>::new();
                for item in batch {
                    let resource_state_index =
                        item.get("resourceStateIndex")
                            .and_then(Value::as_u64)
                            .unwrap_or(usize::MAX as u64) as usize;
                    grouped
                        .entry(resource_state_index)
                        .or_default()
                        .push(packed_failure_item(&item));
                }
                let batch_report = PackedBatchReport {
                    translated_items: Vec::new(),
                    failures: grouped
                        .into_iter()
                        .map(|(resource_state_index, items)| PackedBatchFailure {
                            resource_state_index,
                            error_message: error.to_string(),
                            items,
                        })
                        .collect(),
                };
                apply_packed_translation_report(
                    resource_states,
                    batch_report.clone(),
                    runtime.batch_type,
                    runtime.is_plugin,
                );
                report.failures.extend(batch_report.failures);
                failed_items += batch_failed_count;
                if should_stop_batch_translate_for_failures(failed_items, config.batch_size, config.concurrency) {
                    stop_scheduling = true;
                }
            }
        }

        if completed_since_flush >= flush_every_batches {
            flush_changed_resource_states(runtime.state, runtime.paths, resource_states).await?;
            completed_since_flush = 0;
            if let Some(task) = &task {
                bump_source_revision(task).await;
            }
        }

        if !stop_scheduling {
            while next_batch < batches.len() && handles.len() < concurrency {
                if let Some(task) = &task {
                    ensure_not_cancelled(task).await?;
                }
                let batch = batches[next_batch].clone();
                next_batch += 1;
                let simplified: Vec<Value> = batch.iter().map(&simplify).collect();
                let prompt = prompt.to_string();
                let config = config.clone();
                let task = task.clone();
                handles.spawn(async move {
                    if let Some(task) = &task {
                        ensure_not_cancelled(task).await?;
                    }
                    let result = call_chat_completion(&simplified, &prompt, &config).await;
                    if let Some(task) = &task {
                        ensure_not_cancelled(task).await?;
                    }
                    Ok::<_, anyhow::Error>((batch, result))
                });
            }
        }
    }
    flush_changed_resource_states(runtime.state, runtime.paths, resource_states).await?;
    if let Some(task) = &task {
        bump_source_revision(task).await;
    }

    Ok(report)
}

fn packed_batch_report(
    batch: Vec<Value>,
    translated: Vec<TranslationPair>,
) -> PackedBatchReport {
    let mut report = PackedBatchReport {
        translated_items: Vec::new(),
        failures: Vec::new(),
    };
    let translated_by_id = translated
        .into_iter()
        .map(|entry| (entry.i, entry.t))
        .collect::<HashMap<_, _>>();
    let mut grouped_failures = HashMap::<usize, Vec<BatchTaskFailureItem>>::new();
    for item in batch {
        let id = item.get("id").and_then(Value::as_u64).unwrap_or(0);
        let target = translated_by_id
            .get(&id)
            .map(String::as_str)
            .filter(|value| is_valid_translated_target(value));
        if let Some(target) = target {
            let mut mapped = item.clone();
            mapped["target"] = Value::String(target.to_string());
            report.translated_items.push(mapped);
        } else {
            let resource_state_index = item
                .get("resourceStateIndex")
                .and_then(Value::as_u64)
                .unwrap_or(usize::MAX as u64) as usize;
            grouped_failures
                .entry(resource_state_index)
                .or_default()
                .push(packed_failure_item(&item));
        }
    }
    for (resource_state_index, items) in grouped_failures {
        report.failures.push(PackedBatchFailure {
            resource_state_index,
            error_message: "翻译返回缺少部分条目或包含空译文".to_string(),
            items,
        });
    }
    report
}

#[cfg(test)]
fn merge_successful_packed_response(
    report: &mut PackedBatchReport,
    batch: Vec<Value>,
    translated: Vec<TranslationPair>,
) {
    let batch_report = packed_batch_report(batch, translated);
    report.translated_items.extend(batch_report.translated_items);
    report.failures.extend(batch_report.failures);
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
            resource_state.dirty = true;
            resource_state.success_items.push(compact_success_item_key(&item, batch_type, is_plugin));
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

async fn flush_changed_resource_states(
    state: &AppState,
    paths: &PersistencePaths,
    resource_states: &mut [BatchResourceState],
) -> Result<()> {
    for resource_state in resource_states.iter_mut() {
        if !resource_state.dirty {
            continue;
        }
        save_translated_source_partial(
            state,
            paths,
            &resource_state.source_id,
            &resource_state.translation_json,
        )
        .await?;
        resource_state.dirty = false;
    }
    Ok(())
}

fn compact_success_item_key(item: &Value, batch_type: &str, is_plugin: bool) -> String {
    let index = item.get("dictIndex").and_then(Value::as_u64).unwrap_or(usize::MAX as u64);
    if is_plugin {
        let file = item.get("file").and_then(Value::as_str).unwrap_or_default();
        format!("{file}\t{batch_type}\t{index}")
    } else {
        index.to_string()
    }
}

fn fallback_target(item: &Value) -> String {
    item.get("target")
        .and_then(Value::as_str)
        .or_else(|| item.get("source").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

fn is_valid_translated_target(target: &str) -> bool {
    let trimmed = target.trim();
    if trimmed.is_empty() || trimmed == "空" {
        return false;
    }
    true
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
    let overwrite_existing = config.overwrite_existing_translations;
    if let Some(dict) = translation_json.get("dict").and_then(Value::as_object) {
        for (file, file_dict) in dict {
            if let Some(ast) = file_dict.get("ast").and_then(Value::as_array) {
                for (index, item) in ast.iter().enumerate() {
                    if should_translate(item.get("target"), item.get("source"), overwrite_existing) {
                        ast_items.push(json!({ "id": next_id, "file": file, "dictIndex": index, "type": item.get("type").and_then(Value::as_str).unwrap_or(""), "name": item.get("name").and_then(Value::as_str).unwrap_or(""), "source": item.get("source").and_then(Value::as_str).unwrap_or(""), "target": item.get("target").and_then(Value::as_str).unwrap_or("") }));
                        next_id += 1;
                    }
                }
            }
            if let Some(regex) = file_dict.get("regex").and_then(Value::as_array) {
                for (index, item) in regex.iter().enumerate() {
                    if should_translate(item.get("target"), item.get("source"), overwrite_existing) {
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
    let overwrite_existing = config.overwrite_existing_translations;
    let items: Vec<Value> = translation_json.get("dict").and_then(Value::as_array).map(|dict| {
        dict.iter().enumerate()
            .filter(|(_, item)| should_translate(item.get("target"), item.get("source"), overwrite_existing))
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
    let batches = split_translation_batches(items, config.batch_size, config.batch_char_limit);
    let concurrency = config.concurrency.max(1).min(batches.len().max(1));
    let mut handles = JoinSet::new();
    let mut next_batch = 0usize;
    let mut first_error: Option<anyhow::Error> = None;

    while next_batch < batches.len() && handles.len() < concurrency {
        if let Some(task) = &task {
            ensure_not_cancelled(task).await?;
        }
        let batch = batches[next_batch].clone();
        next_batch += 1;
        let simplified: Vec<Value> = batch.iter().map(&simplify).collect();
        let prompt = prompt.to_string();
        let config = config.clone();
        let task = task.clone();
        handles.spawn(async move {
            if let Some(task) = &task {
                ensure_not_cancelled(task).await?;
            }
            let result = call_chat_completion(&simplified, &prompt, &config).await;
            if let Some(task) = &task {
                ensure_not_cancelled(task).await?;
            }
            Ok::<_, anyhow::Error>((batch, result))
        });
    }

    while let Some(handle) = handles.join_next().await {
        if let Some(task) = &task {
            ensure_not_cancelled(task).await?;
        }
        let (batch, result) = handle??;
        if let Some(task) = &task {
            increment_progress(task, "processedItems", batch.len()).await;
        }
        match result {
            Ok(translated) => {
                for item in &batch {
                    let id = item.get("id").and_then(Value::as_u64).unwrap_or(0);
                    let mut mapped = item.clone();
                    let target = translated
                        .iter()
                        .find(|entry| entry.i == id)
                        .map(|entry| entry.t.as_str())
                        .filter(|value| is_valid_translated_target(value));
                    let Some(target) = target else {
                        if first_error.is_none() {
                            first_error = Some(anyhow!("翻译返回缺少部分条目或包含空译文"));
                        }
                        continue;
                    };
                    mapped["target"] = Value::String(target.to_string());
                    output.push(mapped);
                }
            }
            Err(error) if error.to_string().contains(MANUAL_STOP) => return Err(error),
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }

        while first_error.is_none() && next_batch < batches.len() && handles.len() < concurrency {
            if let Some(task) = &task {
                ensure_not_cancelled(task).await?;
            }
            let batch = batches[next_batch].clone();
            next_batch += 1;
            let simplified: Vec<Value> = batch.iter().map(&simplify).collect();
            let prompt = prompt.to_string();
            let config = config.clone();
            let task = task.clone();
            handles.spawn(async move {
                if let Some(task) = &task {
                    ensure_not_cancelled(task).await?;
                }
                let result = call_chat_completion(&simplified, &prompt, &config).await;
                if let Some(task) = &task {
                    ensure_not_cancelled(task).await?;
                }
                Ok::<_, anyhow::Error>((batch, result))
            });
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(output)
}

fn split_translation_batches(items: &[Value], batch_size: usize, batch_char_limit: usize) -> Vec<Vec<Value>> {
    let batch_size = batch_size.max(1);
    let mut batches = Vec::new();
    for batch in items.chunks(batch_size) {
        split_translation_batch_by_char_limit(batch.to_vec(), batch_char_limit, &mut batches);
    }
    batches
}

fn split_translation_batch_by_char_limit(
    batch: Vec<Value>,
    batch_char_limit: usize,
    output: &mut Vec<Vec<Value>>,
) {
    if batch.is_empty() {
        return;
    }
    if batch_char_limit == 0
        || batch.len() == 1
        || translation_batch_source_char_count(&batch) <= batch_char_limit
    {
        output.push(batch);
        return;
    }

    let mid = (batch.len() + 1) / 2;
    let right = batch[mid..].to_vec();
    let left = batch[..mid].to_vec();
    split_translation_batch_by_char_limit(left, batch_char_limit, output);
    split_translation_batch_by_char_limit(right, batch_char_limit, output);
}

fn translation_batch_source_char_count(batch: &[Value]) -> usize {
    batch
        .iter()
        .map(|item| {
            item.get("source")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .count()
        })
        .sum()
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
    let request = client
        .post(&config.chat_completions_url)
        .header("content-type", "application/json")
        .bearer_auth(&config.api_key)
        .body(request.to_string());
    let mut response = tokio_timeout(Duration::from_millis(timeout_ms), request.send())
        .await
        .map_err(|_| {
            anyhow!(
                "AI 首字响应超时（耗时 {}，超时 {}）",
                format_duration(now_ms() - started),
                format_duration(timeout_ms)
            )
        })?
        .map_err(|error| normalize_ai_error(error, started, timeout_ms))?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or_default().to_string();
    let text = read_response_text_with_first_chunk_timeout(&mut response, started, timeout_ms).await?;
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
        .unwrap_or_default();
    if assistant.trim().is_empty() {
        let reasoning_tokens = parsed
            .pointer("/usage/completion_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let finish_reason = parsed
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if reasoning_tokens > 0 || finish_reason == "length" {
            return Err(anyhow!(
                "AI 返回的 message.content 为空（耗时 {}，reasoning_tokens={}，finish_reason={}）。请关闭或降低模型思考输出，或提高输出 token 上限。",
                format_duration(now_ms() - started),
                reasoning_tokens,
                finish_reason
            ));
        }
        return Err(anyhow!(
            "AI 返回缺少 message.content（耗时 {}）",
            format_duration(now_ms() - started)
        ));
    }
    parse_translation_response(assistant).map_err(|error| {
        anyhow!(
            "AI 翻译结果解析失败（耗时 {}）：{}",
            format_duration(now_ms() - started),
            error
        )
    })
}

async fn read_response_text_with_first_chunk_timeout(
    response: &mut reqwest::Response,
    started: u64,
    timeout_ms: u64,
) -> Result<String> {
    let mut bytes = Vec::new();
    let first_content_deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let now = tokio::time::Instant::now();
        if now >= first_content_deadline {
            return Err(anyhow!(
                "AI 首个内容响应超时（耗时 {}，超时 {}）",
                format_duration(now_ms() - started),
                format_duration(timeout_ms)
            ));
        }
        let remaining = first_content_deadline.saturating_duration_since(now);
        let chunk = tokio_timeout(remaining, response.chunk())
            .await
            .map_err(|_| {
                anyhow!(
                    "AI 首个内容响应超时（耗时 {}，超时 {}）",
                    format_duration(now_ms() - started),
                    format_duration(timeout_ms)
                )
            })?
            .map_err(|error| normalize_ai_error(error, started, timeout_ms))?;

        let Some(chunk) = chunk else {
            return Ok(String::from_utf8(bytes).map_err(|error| {
                anyhow!(
                    "AI 返回非 UTF-8 响应（耗时 {}）：{}",
                    format_duration(now_ms() - started),
                    error
                )
            })?);
        };
        bytes.extend_from_slice(&chunk);
        if response_text_has_activity_delta(&bytes) {
            break;
        }
    }

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| normalize_ai_error(error, started, timeout_ms))?
    {
        bytes.extend_from_slice(&chunk);
    }

    String::from_utf8(bytes)
        .map_err(|error| anyhow!("AI 返回非 UTF-8 响应（耗时 {}）：{}", format_duration(now_ms() - started), error))
}

fn response_text_has_activity_delta(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let trimmed = text.trim_start();
    if !trimmed.starts_with("data:") {
        return !trimmed.is_empty();
    }
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
            if event
                .pointer("/choices/0/delta/content")
                .or_else(|| event.pointer("/choices/0/message/content"))
                .or_else(|| event.pointer("/choices/0/delta/reasoning_content"))
                .or_else(|| event.pointer("/choices/0/message/reasoning_content"))
                .or_else(|| event.pointer("/choices/0/delta/reasoning"))
                .or_else(|| event.pointer("/choices/0/message/reasoning"))
                .or_else(|| event.get("reasoning_content"))
                .or_else(|| event.get("reasoning"))
                .and_then(Value::as_str)
                .map(|content| !content.is_empty())
                .unwrap_or(false)
            {
                return true;
            }
        }
    }
    false
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

fn should_translate(target: Option<&Value>, source: Option<&Value>, overwrite_existing: bool) -> bool {
    let target = target.and_then(Value::as_str).unwrap_or_default();
    let source = source.and_then(Value::as_str).unwrap_or_default();
    overwrite_existing || target.trim().is_empty() || target == source
}

fn count_pending_plugin_items(json: &Value, overwrite_existing: bool) -> usize {
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
                                    should_translate(item.get("target"), item.get("source"), overwrite_existing)
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
                                    should_translate(item.get("target"), item.get("source"), overwrite_existing)
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

fn count_pending_theme_items(json: &Value, overwrite_existing: bool) -> usize {
    json.get("dict")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| should_translate(item.get("target"), item.get("source"), overwrite_existing))
                .count()
        })
        .unwrap_or(0)
}

async fn handle_plugin_retry(payload: Value, task: Option<Arc<TaskRuntime>>) -> Result<Value> {
    let mut completed_ids = Vec::new();
    let mut failed_ids = Vec::new();
    let mut skipped_ids = Vec::new();
    let mut updates = Vec::new();
    let config: CompanionTranslationConfig =
        serde_json::from_value(payload.get("config").cloned().unwrap_or(Value::Null))?;
    let failures = payload
        .get("failures")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut ast_items = Vec::new();
    let mut regex_items = Vec::new();
    let mut ast_id = 0u64;
    let mut regex_id = 0u64;
    let mut ast_failure_item_counts = HashMap::<String, usize>::new();
    let mut regex_failure_item_counts = HashMap::<String, usize>::new();
    let mut retry_failure_ids = Vec::<String>::new();
    let mut processed_items = 0usize;

    for failure in failures {
        let failure_id = failure
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let batch_type = failure
            .get("batchType")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if batch_type != "ast" && batch_type != "regex" {
            skipped_ids.push(failure_id);
            continue;
        }
        let failure_items = failure
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if failure_items.is_empty() {
            skipped_ids.push(failure_id);
            continue;
        }
        retry_failure_ids.push(failure_id.clone());
        if batch_type == "ast" {
            ast_failure_item_counts.insert(failure_id.clone(), failure_items.len());
        } else {
            regex_failure_item_counts.insert(failure_id.clone(), failure_items.len());
        }
        for item in failure_items {
            if batch_type == "ast" {
                ast_items.push(json!({
                    "id": ast_id,
                    "failureId": failure_id,
                    "file": item.get("file").and_then(Value::as_str).unwrap_or_default(),
                    "dictIndex": item.get("dictIndex").and_then(Value::as_i64).unwrap_or(-1),
                    "type": item.get("type").and_then(Value::as_str).unwrap_or(""),
                    "name": item.get("name").and_then(Value::as_str).unwrap_or(""),
                    "source": item.get("source").and_then(Value::as_str).unwrap_or(""),
                    "target": item.get("target").and_then(Value::as_str).unwrap_or(""),
                }));
                ast_id += 1;
            } else {
                regex_items.push(json!({
                    "id": regex_id,
                    "failureId": failure_id,
                    "file": item.get("file").and_then(Value::as_str).unwrap_or_default(),
                    "dictIndex": item.get("dictIndex").and_then(Value::as_i64).unwrap_or(-1),
                    "source": item.get("source").and_then(Value::as_str).unwrap_or(""),
                    "target": item.get("target").and_then(Value::as_str).unwrap_or(""),
                }));
                regex_id += 1;
            }
        }
    }

    let ast_result = translate_value_batches(
        &ast_items,
        &config.prompts.ast,
        &config,
        |item| json!({ "i": item["id"], "s": item["source"], "y": item["type"], "n": item["name"] }),
        task.clone(),
    )
    .await;
    apply_plugin_retry_result(
        ast_result,
        "ast",
        &mut updates,
        &mut processed_items,
        &mut completed_ids,
        &mut failed_ids,
        &ast_failure_item_counts,
    )?;

    let regex_result = translate_value_batches(
        &regex_items,
        &config.prompts.regex,
        &config,
        |item| json!({ "i": item["id"], "s": item["source"] }),
        task.clone(),
    )
    .await;
    apply_plugin_retry_result(
        regex_result,
        "regex",
        &mut updates,
        &mut processed_items,
        &mut completed_ids,
        &mut failed_ids,
        &regex_failure_item_counts,
    )?;

    for failure_id in retry_failure_ids {
        if !completed_ids.contains(&failure_id)
            && !failed_ids.contains(&failure_id)
            && !skipped_ids.contains(&failure_id)
        {
            failed_ids.push(failure_id);
        }
    }

    Ok(
        json!({ "updates": updates, "processedItems": processed_items, "completedFailureIds": completed_ids, "failedFailureIds": failed_ids, "skippedFailureIds": skipped_ids }),
    )
}

fn apply_plugin_retry_result(
    result: Result<Vec<Value>>,
    batch_type: &str,
    updates: &mut Vec<Value>,
    processed_items: &mut usize,
    completed_ids: &mut Vec<String>,
    failed_ids: &mut Vec<String>,
    failure_item_counts: &HashMap<String, usize>,
) -> Result<()> {
    match result {
        Ok(result_items) => {
            *processed_items += result_items.len();
            let mut result_counts = HashMap::<String, usize>::new();
            for item in result_items {
                let failure_id = item
                    .get("failureId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                *result_counts.entry(failure_id.clone()).or_default() += 1;
                updates.push(json!({ "batchType": batch_type, "failureId": item["failureId"], "file": item["file"], "dictIndex": item["dictIndex"], "target": item["target"] }));
            }
            for (failure_id, expected_count) in failure_item_counts {
                if result_counts.get(failure_id).copied().unwrap_or(0) == *expected_count {
                    push_unique(completed_ids, failure_id.clone());
                } else if result_counts.contains_key(failure_id) {
                    push_unique(failed_ids, failure_id.clone());
                }
            }
        }
        Err(error) if error.to_string().contains(MANUAL_STOP) => return Err(error),
        Err(_) => {
            *processed_items += failure_item_counts.values().sum::<usize>();
            for failure_id in failure_item_counts.keys() {
                push_unique(failed_ids, failure_id.clone());
            }
        }
    }
    Ok(())
}

fn apply_theme_retry_result(
    result: Result<Vec<Value>>,
    updates: &mut Vec<Value>,
    processed_items: &mut usize,
    completed_ids: &mut Vec<String>,
    failed_ids: &mut Vec<String>,
    failure_item_counts: &HashMap<String, usize>,
) -> Result<()> {
    match result {
        Ok(result_items) => {
            *processed_items += result_items.len();
            let mut result_counts = HashMap::<String, usize>::new();
            for item in result_items {
                let failure_id = item
                    .get("failureId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                *result_counts.entry(failure_id.clone()).or_default() += 1;
                updates.push(json!({ "batchType": "theme", "failureId": item["failureId"], "dictIndex": item["dictIndex"], "target": item["target"] }));
            }
            for (failure_id, expected_count) in failure_item_counts {
                if result_counts.get(failure_id).copied().unwrap_or(0) == *expected_count {
                    push_unique(completed_ids, failure_id.clone());
                } else if result_counts.contains_key(failure_id) {
                    push_unique(failed_ids, failure_id.clone());
                }
            }
        }
        Err(error) if error.to_string().contains(MANUAL_STOP) => return Err(error),
        Err(_) => {
            *processed_items += failure_item_counts.values().sum::<usize>();
            for failure_id in failure_item_counts.keys() {
                push_unique(failed_ids, failure_id.clone());
            }
        }
    }
    Ok(())
}

fn push_unique(items: &mut Vec<String>, value: String) {
    if !items.contains(&value) {
        items.push(value);
    }
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
    let mut items = Vec::new();
    let mut next_id = 0u64;
    let mut failure_item_counts = HashMap::<String, usize>::new();

    for failure in failures {
        let failure_id = failure
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if failure.get("batchType").and_then(Value::as_str) != Some("theme") {
            skipped_ids.push(failure_id);
            continue;
        }
        let failure_items = failure
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if failure_items.is_empty() {
            skipped_ids.push(failure_id);
            continue;
        }
        failure_item_counts.insert(failure_id.clone(), failure_items.len());
        for item in failure_items {
            items.push(json!({
                "id": next_id,
                "failureId": failure_id,
                "dictIndex": item.get("dictIndex").and_then(Value::as_i64).unwrap_or(-1),
                "type": item.get("type").and_then(Value::as_str).unwrap_or(""),
                "source": item.get("source").and_then(Value::as_str).unwrap_or(""),
                "target": item.get("target").and_then(Value::as_str).unwrap_or(""),
            }));
            next_id += 1;
        }
    }

    let result = translate_value_batches(
        &items,
        &config.prompts.theme,
        &config,
        |item| json!({ "i": item["id"], "s": item["source"], "y": item["type"] }),
        task.clone(),
    )
    .await;
    apply_theme_retry_result(
        result,
        &mut updates,
        &mut processed_items,
        &mut completed_ids,
        &mut failed_ids,
        &failure_item_counts,
    )?;

    for failure_id in failure_item_counts.keys() {
        if !completed_ids.contains(failure_id)
            && !failed_ids.contains(failure_id)
            && !skipped_ids.contains(failure_id)
        {
            failed_ids.push(failure_id.clone());
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
    let scope = if is_plugin { "plugin" } else { "theme" };
    let item_limit = translate_window_item_limit(
        retry.config.batch_size,
        retry.config.concurrency,
        retry.config.batch_window_multiplier,
    );
    let mut retry_queue = load_retry_failures_for_scope(&paths, scope);
    let mut failed_retry_ids = HashSet::<String>::new();
    let mut processed_retry_ids = HashSet::<String>::new();

    while !retry_queue.is_empty() {
        if !is_task_active(&task).await {
            break;
        }
        let window = collect_failure_retry_window(&retry_queue, item_limit);
        if window.is_empty() {
            break;
        }
        let mut groups: HashMap<String, Vec<BatchTaskFailureRecord>> = HashMap::new();
        for failure in &window {
            groups
                .entry(failure.source_id.clone())
                .or_default()
                .push(failure.clone());
        }

        for failures in groups.into_values() {
            if !is_task_active(&task).await {
                break;
            }
            let first = failures.first().cloned().context("empty failure group")?;
            touch_progress(&task, json!({ "currentLabel": first.resource_label })).await;
            let Some(mut translation_json) = read_translation(&paths, &first.source_id) else {
                let skipped_ids = failures.iter().map(|failure| failure.id.clone()).collect::<Vec<_>>();
                remove_failures(state, &paths, &skipped_ids).await?;
                increment_progress(&task, "processedItems", retry_failure_item_count(&failures)).await;
                increment_progress(&task, "skippedCount", failures.len()).await;
                increment_progress(&task, "processedResources", count_new_retry_failures(&mut processed_retry_ids, &failures)).await;
                bump_record_revision(&task).await;
                continue;
            };
            let payload = json!({ "resourceId": first.resource_id, "resourceLabel": first.resource_label, "sourceId": first.source_id, "failures": failures.clone(), "config": retry.config });
            let processed_items_before = task.progress.lock().await.processed_items;
            let result = if is_plugin {
                handle_plugin_retry(payload, Some(task.clone())).await
            } else {
                handle_theme_retry(payload, Some(task.clone())).await
            }?;
            let processed_items_after = task.progress.lock().await.processed_items;
            let updates = result
                .get("updates")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            apply_retry_updates_to_translation(&mut translation_json, &updates, is_plugin);
            save_translated_source(state, &paths, &first.source_id, &translation_json).await?;
            let completed_items = updates
                .iter()
                .map(retry_completed_item_key_from_value)
                .collect::<Vec<_>>();
            let mut completed_failure_ids = Vec::new();
            update_record(state, &paths, |record| {
                completed_failure_ids =
                    remove_completed_retry_items_from_record(record, scope, &completed_items);
            })
            .await?;
            update_retry_source_processing_state(state, &paths, scope, &first.source_id).await?;
            for failure_id in &completed_failure_ids {
                failed_retry_ids.remove(failure_id);
            }
            if let Some(failed_ids) = result.get("failedFailureIds").and_then(Value::as_array) {
                for failure_id in failed_ids.iter().filter_map(Value::as_str) {
                    if !completed_failure_ids.iter().any(|completed| completed == failure_id) {
                        failed_retry_ids.insert(failure_id.to_string());
                    }
                }
            }
            touch_progress(&task, json!({ "failedCount": failed_retry_ids.len() })).await;
            increment_progress(
                &task,
                "processedItems",
                (result
                    .get("processedItems")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize)
                    .saturating_sub(processed_items_after.saturating_sub(processed_items_before)),
            )
            .await;
            increment_progress(
                &task,
                "successCount",
                completed_failure_ids.len(),
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
            increment_progress(&task, "processedResources", count_new_retry_failures(&mut processed_retry_ids, &failures)).await;
            bump_source_revision(&task).await;
            bump_record_revision(&task).await;
        }
        prune_retry_window_from_queue(&mut retry_queue, &window);
    }
    Ok(())
}

fn retry_failure_item_count(failures: &[BatchTaskFailureRecord]) -> usize {
    failures.iter().map(|failure| failure.items.len()).sum()
}

fn count_new_retry_failures(seen: &mut HashSet<String>, failures: &[BatchTaskFailureRecord]) -> usize {
    failures.iter().filter(|failure| seen.insert(failure.id.clone())).count()
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

fn default_translate_window_batch_multiplier() -> usize {
    DEFAULT_TRANSLATE_WINDOW_BATCH_MULTIPLIER
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::AsyncWriteExt,
        net::TcpListener,
        sync::mpsc,
        time::{sleep, Duration as TokioDuration},
    };

    #[test]
    fn translate_window_item_limit_feeds_concurrency_without_scaling_to_resources() {
        assert_eq!(translate_window_item_limit(5, 3, 4), 60);
        assert_eq!(translate_window_item_limit(1, 3, 4), 12);
        assert_eq!(translate_window_item_limit(10, 0, 4), 40);
        assert_eq!(translate_window_item_limit(5, 3, 2), 30);
        assert_eq!(translate_window_item_limit(5, 3, 0), 15);
    }

    #[test]
    fn batch_translate_stops_when_failed_items_reach_request_capacity() {
        assert!(!should_stop_batch_translate_for_failures(499, 100, 5));
        assert!(should_stop_batch_translate_for_failures(500, 100, 5));
        assert!(should_stop_batch_translate_for_failures(1, 0, 0));
    }

    #[test]
    fn translation_batches_split_by_item_count_then_source_character_limit() {
        let items = vec![
            json!({ "source": "abcd" }),
            json!({ "source": "efgh" }),
            json!({ "source": "ijk" }),
            json!({ "source": "lmn" }),
            json!({ "source": "op" }),
        ];

        let batches = split_translation_batches(&items, 5, 8);

        assert_eq!(batches.len(), 3);
        assert_eq!(batches.iter().map(Vec::len).sum::<usize>(), items.len());
        assert!(batches
            .iter()
            .all(|batch| batch.len() == 1 || translation_batch_source_char_count(batch) <= 8));
        let flattened = batches
            .iter()
            .flatten()
            .map(|item| item.get("source").and_then(Value::as_str).unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(flattened, vec!["abcd", "efgh", "ijk", "lmn", "op"]);
    }

    #[test]
    fn translation_batches_leave_single_oversized_item_intact() {
        let items = vec![
            json!({ "source": "abcdefghijk" }),
            json!({ "source": "xy" }),
        ];

        let batches = split_translation_batches(&items, 2, 5);

        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 1);
        assert_eq!(
            batches[0][0].get("source").and_then(Value::as_str),
            Some("abcdefghijk")
        );
        assert_eq!(batches[1].len(), 1);
    }

    #[test]
    fn diagnose_cleanup_removes_multiple_syntax_breaking_items() {
        let original_code = r#"const label = "Hello"; const tip = "Tip"; const ok = "Okay";"#;
        let mut translation_json = json!({
            "schemaVersion": 1,
            "metadata": {
                "plugin": "demo-plugin",
                "language": "zh-CN",
                "version": "1.0.0",
                "supportedVersions": "*",
                "title": "Demo",
                "description": "",
                "author": ""
            },
            "dict": {
                "main.js": {
                    "ast": [],
                    "regex": [
                        { "source": "Hello", "target": "\"; const broken = ; //" },
                        { "source": "Tip", "target": "提示" },
                        { "source": "Okay", "target": "\"; if ( ; //" }
                    ]
                }
            }
        });

        let report = diagnose_and_clean_translation_json(
            &mut translation_json,
            &HashMap::from([("main.js".to_string(), original_code.to_string())]),
            true,
            true,
        )
        .unwrap();

        assert_eq!(report.removed_items.len(), 2);
        assert!(report.removed_items.iter().any(|item| item.source == "Hello"));
        assert!(report.removed_items.iter().any(|item| item.source == "Okay"));
        assert_eq!(
            translation_json
                .pointer("/dict/main.js/regex")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .map(|item| item.get("source").and_then(Value::as_str).unwrap_or_default())
                .collect::<Vec<_>>(),
            vec!["Tip"]
        );
    }

    #[test]
    fn metadata_index_separates_translated_entries_from_processing_progress() {
        let index = metadata_index(&json!({
            "schemaVersion": 1,
            "metadata": { "version": "1.0.0" },
            "dict": [
                { "source": "A", "target": "甲" },
                { "source": "B", "target": "B" },
                { "source": "C", "target": "" }
            ]
        }));

        assert_eq!(index.get("translatedEntryCount").and_then(Value::as_u64), Some(1));
        assert_eq!(index.get("pendingTranslationCount").and_then(Value::as_u64), Some(2));
        assert_eq!(index.get("processedTranslationCount").and_then(Value::as_u64), Some(0));
        assert_eq!(
            index
                .get("translationProcessingComplete")
                .and_then(Value::as_bool),
            Some(false)
        );
    }

    #[tokio::test]
    async fn retry_processing_state_counts_ai_completed_items_even_when_target_matches_source() {
        let base_path = env::temp_dir().join(format!("i18n-retry-state-{}", nanoid!()));
        let paths = paths(base_path.to_str().unwrap());
        write_json_pretty(
            &paths.meta_path,
            &json!({
                "schemaVersion": 2,
                "sources": {
                    "source-a": {
                        "id": "source-a",
                        "plugin": "plugin-a",
                        "type": "plugin",
                        "totalTranslationCount": 2,
                        "processedTranslationCount": 1,
                        "unprocessedTranslationCount": 1,
                        "translationProcessingComplete": false
                    }
                }
            }),
        )
        .unwrap();
        write_json_pretty(
            &paths.batch_task_record_path,
            &json!({
                "schemaVersion": 1,
                "checkpoints": {},
                "failures": [],
                "successBatches": [],
                "updatedAt": 0
            }),
        )
        .unwrap();
        let state = AppState {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            diagnose_sessions: Arc::new(Mutex::new(HashMap::new())),
            persistence_lock: Arc::new(Mutex::new(())),
            plugin_dir: base_path.clone(),
            http: reqwest::Client::new(),
            shutdown: Arc::new(Mutex::new(None)),
        };

        let processing_state =
            update_retry_source_processing_state(&state, &paths, "plugin", "source-a")
                .await
                .unwrap();

        assert!(processing_state.complete);
        assert_eq!(processing_state.processed_count, 2);
        assert_eq!(processing_state.unprocessed_count, 0);
        let meta = load_meta(&paths);
        let source = meta.pointer("/sources/source-a").unwrap();
        assert_eq!(
            source
                .get("processedTranslationCount")
                .and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            source
                .get("translationProcessingComplete")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[tokio::test]
    async fn batch_translate_writes_successful_plugin_items_to_source_file() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _request = read_test_http_request(&mut stream).await;
            let body = json!({
                "choices": [{
                    "message": { "content": "{\"items\":[{\"i\":0,\"t\":\"你好\"}]}" },
                    "finish_reason": "stop"
                }]
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let base_path = env::temp_dir().join(format!("i18n-batch-translate-write-{}", nanoid!()));
        let paths = paths(base_path.to_str().unwrap());
        let source_id = "source-a";
        let translation_json = json!({
            "schemaVersion": 1,
            "metadata": {
                "plugin": "plugin-a",
                "title": "Plugin A",
                "version": "1.0.0",
                "supportedVersions": "1.0.0",
                "language": "zh-cn"
            },
            "dict": {
                "main.js": {
                    "ast": [],
                    "regex": [
                        { "source": "Hello", "target": "Hello" }
                    ]
                }
            }
        });
        write_json_pretty(
            &paths.meta_path,
            &json!({
                "schemaVersion": 2,
                "sources": {
                    source_id: {
                        "id": source_id,
                        "plugin": "plugin-a",
                        "title": "Plugin A",
                        "type": "plugin",
                        "origin": "local",
                        "isActive": true,
                        "checksum": "",
                        "translationVersion": "1.0.0",
                        "translationFormatValid": true,
                        "totalTranslationCount": 1,
                        "pendingTranslationCount": 1,
                        "translatedEntryCount": 0,
                        "processedTranslationCount": 0,
                        "unprocessedTranslationCount": 1,
                        "translationProcessingComplete": false,
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                }
            }),
        )
        .unwrap();
        save_translation(&paths, source_id, &translation_json).unwrap();

        let state = AppState {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            diagnose_sessions: Arc::new(Mutex::new(HashMap::new())),
            persistence_lock: Arc::new(Mutex::new(())),
            plugin_dir: base_path.clone(),
            http: reqwest::Client::new(),
            shutdown: Arc::new(Mutex::new(None)),
        };
        let task = Arc::new(TaskRuntime {
            progress: Mutex::new(CompanionTaskProgress {
                task_id: "task".to_string(),
                scope: "plugin".to_string(),
                mode: "translate".to_string(),
                status: "running".to_string(),
                current_label: String::new(),
                processed_resources: 0,
                total_resources: 1,
                processed_items: 0,
                total_items: 1,
                success_count: 0,
                failed_count: 0,
                skipped_count: 0,
                source_revision: 0,
                record_revision: 0,
                updated_at: 0,
                error: None,
            }),
            cancel_requested: Mutex::new(false),
        });
        let batch = PluginBatchTranslatePayload {
            persistence: PersistenceConfig {
                base_path: base_path.to_string_lossy().to_string(),
            },
            resources: vec![CompanionBatchResource {
                resource_id: "plugin-a".to_string(),
                label: "Plugin A".to_string(),
                source_id: Some(source_id.to_string()),
            }],
            config: CompanionTranslationConfig {
                chat_completions_url: format!("http://{addr}/v1/chat/completions"),
                api_key: "test-key".to_string(),
                model: "test-model".to_string(),
                timeout_ms: 5_000,
                response_format: "json_object".to_string(),
                batch_size: 1,
                batch_char_limit: 0,
                batch_window_multiplier: 4,
                overwrite_existing_translations: false,
                concurrency: 1,
                prompts: PromptConfig {
                    ast: String::new(),
                    regex: String::new(),
                    theme: String::new(),
                },
            },
            checkpoint_key: "plugin:translate".to_string(),
            concurrency: 1,
            completed_resources: None,
            processed_items: None,
            total_items: Some(1),
        };

        handle_batch_translate(&state, task.clone(), batch, true)
            .await
            .unwrap();

        let saved = read_translation(&paths, source_id).unwrap();
        assert_eq!(
            saved.pointer("/dict/main.js/regex/0/target").and_then(Value::as_str),
            Some("你好")
        );
        let meta = load_meta(&paths);
        let source = meta.pointer("/sources/source-a").unwrap();
        assert_eq!(
            source.get("translatedEntryCount").and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            source.get("processedTranslationCount").and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            source.get("unprocessedTranslationCount").and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            source
                .get("translationProcessingComplete")
                .and_then(Value::as_bool),
            Some(true)
        );
        let progress = task.progress.lock().await.clone();
        assert_eq!(progress.processed_resources, 1);
        assert_eq!(progress.processed_items, 1);
        assert_eq!(progress.success_count, 1);
        let _ = fs::remove_dir_all(base_path);
    }

    #[tokio::test]
    async fn batch_translate_persists_partial_success_before_failure_threshold_stops_task() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let request = read_test_http_request(&mut stream).await;
                    let id = request_item_id(&request);
                    let content = if id == 0 {
                        "{\"items\":[{\"i\":0,\"t\":\"你好\"}]}"
                    } else {
                        "{\"items\":[{\"i\":1,\"t\":\"\"}]}"
                    };
                    let body = json!({
                        "choices": [{
                            "message": { "content": content },
                            "finish_reason": "stop"
                        }]
                    })
                    .to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });

        let base_path = env::temp_dir().join(format!("i18n-batch-translate-threshold-{}", nanoid!()));
        let paths = paths(base_path.to_str().unwrap());
        let source_id = "source-a";
        let translation_json = json!({
            "schemaVersion": 1,
            "metadata": {
                "plugin": "plugin-a",
                "title": "Plugin A",
                "version": "1.0.0",
                "supportedVersions": "1.0.0",
                "language": "zh-cn"
            },
            "dict": {
                "main.js": {
                    "ast": [],
                    "regex": [
                        { "source": "Hello", "target": "Hello" },
                        { "source": "World", "target": "World" }
                    ]
                }
            }
        });
        write_json_pretty(
            &paths.meta_path,
            &json!({
                "schemaVersion": 2,
                "sources": {
                    source_id: {
                        "id": source_id,
                        "plugin": "plugin-a",
                        "title": "Plugin A",
                        "type": "plugin",
                        "origin": "local",
                        "isActive": true,
                        "checksum": "",
                        "translationVersion": "1.0.0",
                        "translationFormatValid": true,
                        "totalTranslationCount": 2,
                        "pendingTranslationCount": 2,
                        "translatedEntryCount": 0,
                        "processedTranslationCount": 0,
                        "unprocessedTranslationCount": 2,
                        "translationProcessingComplete": false,
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                }
            }),
        )
        .unwrap();
        save_translation(&paths, source_id, &translation_json).unwrap();

        let state = AppState {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            diagnose_sessions: Arc::new(Mutex::new(HashMap::new())),
            persistence_lock: Arc::new(Mutex::new(())),
            plugin_dir: base_path.clone(),
            http: reqwest::Client::new(),
            shutdown: Arc::new(Mutex::new(None)),
        };
        let task = Arc::new(TaskRuntime {
            progress: Mutex::new(CompanionTaskProgress {
                task_id: "task".to_string(),
                scope: "plugin".to_string(),
                mode: "translate".to_string(),
                status: "running".to_string(),
                current_label: String::new(),
                processed_resources: 0,
                total_resources: 1,
                processed_items: 0,
                total_items: 2,
                success_count: 0,
                failed_count: 0,
                skipped_count: 0,
                source_revision: 0,
                record_revision: 0,
                updated_at: 0,
                error: None,
            }),
            cancel_requested: Mutex::new(false),
        });
        let batch = PluginBatchTranslatePayload {
            persistence: PersistenceConfig {
                base_path: base_path.to_string_lossy().to_string(),
            },
            resources: vec![CompanionBatchResource {
                resource_id: "plugin-a".to_string(),
                label: "Plugin A".to_string(),
                source_id: Some(source_id.to_string()),
            }],
            config: CompanionTranslationConfig {
                chat_completions_url: format!("http://{addr}/v1/chat/completions"),
                api_key: "test-key".to_string(),
                model: "test-model".to_string(),
                timeout_ms: 5_000,
                response_format: "json_object".to_string(),
                batch_size: 1,
                batch_char_limit: 0,
                batch_window_multiplier: 4,
                overwrite_existing_translations: false,
                concurrency: 1,
                prompts: PromptConfig {
                    ast: String::new(),
                    regex: String::new(),
                    theme: String::new(),
                },
            },
            checkpoint_key: "plugin:translate".to_string(),
            concurrency: 1,
            completed_resources: None,
            processed_items: None,
            total_items: Some(2),
        };

        let result = handle_batch_translate(&state, task.clone(), batch, true).await;

        assert!(result.is_err());
        let saved = read_translation(&paths, source_id).unwrap();
        assert_eq!(
            saved.pointer("/dict/main.js/regex/0/target").and_then(Value::as_str),
            Some("你好")
        );
        let meta = load_meta(&paths);
        let source = meta.pointer("/sources/source-a").unwrap();
        assert_eq!(
            source.get("translatedEntryCount").and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            source.get("processedTranslationCount").and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            source.get("unprocessedTranslationCount").and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            source
                .get("translationProcessingComplete")
                .and_then(Value::as_bool),
            Some(false)
        );
        let _ = fs::remove_dir_all(base_path);
    }

    #[tokio::test]
    async fn batch_translate_records_request_failures_when_threshold_stops_task() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _request = read_test_http_request(&mut stream).await;
            let body = "temporary failure";
            let response = format!(
                "HTTP/1.1 500 Internal Server Error\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let base_path = env::temp_dir().join(format!("i18n-batch-translate-request-failure-{}", nanoid!()));
        let paths = paths(base_path.to_str().unwrap());
        let source_id = "source-a";
        let translation_json = json!({
            "schemaVersion": 1,
            "metadata": {
                "plugin": "plugin-a",
                "title": "Plugin A",
                "version": "1.0.0",
                "supportedVersions": "1.0.0",
                "language": "zh-cn"
            },
            "dict": {
                "main.js": {
                    "ast": [],
                    "regex": [
                        { "source": "Hello", "target": "Hello" }
                    ]
                }
            }
        });
        write_json_pretty(
            &paths.meta_path,
            &json!({
                "schemaVersion": 2,
                "sources": {
                    source_id: {
                        "id": source_id,
                        "plugin": "plugin-a",
                        "title": "Plugin A",
                        "type": "plugin",
                        "origin": "local",
                        "isActive": true,
                        "checksum": "",
                        "translationVersion": "1.0.0",
                        "translationFormatValid": true,
                        "totalTranslationCount": 1,
                        "pendingTranslationCount": 1,
                        "translatedEntryCount": 0,
                        "processedTranslationCount": 0,
                        "unprocessedTranslationCount": 1,
                        "translationProcessingComplete": false,
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                }
            }),
        )
        .unwrap();
        save_translation(&paths, source_id, &translation_json).unwrap();

        let state = AppState {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            diagnose_sessions: Arc::new(Mutex::new(HashMap::new())),
            persistence_lock: Arc::new(Mutex::new(())),
            plugin_dir: base_path.clone(),
            http: reqwest::Client::new(),
            shutdown: Arc::new(Mutex::new(None)),
        };
        let task = Arc::new(TaskRuntime {
            progress: Mutex::new(CompanionTaskProgress {
                task_id: "task".to_string(),
                scope: "plugin".to_string(),
                mode: "translate".to_string(),
                status: "running".to_string(),
                current_label: String::new(),
                processed_resources: 0,
                total_resources: 1,
                processed_items: 0,
                total_items: 1,
                success_count: 0,
                failed_count: 0,
                skipped_count: 0,
                source_revision: 0,
                record_revision: 0,
                updated_at: 0,
                error: None,
            }),
            cancel_requested: Mutex::new(false),
        });
        let batch = PluginBatchTranslatePayload {
            persistence: PersistenceConfig {
                base_path: base_path.to_string_lossy().to_string(),
            },
            resources: vec![CompanionBatchResource {
                resource_id: "plugin-a".to_string(),
                label: "Plugin A".to_string(),
                source_id: Some(source_id.to_string()),
            }],
            config: CompanionTranslationConfig {
                chat_completions_url: format!("http://{addr}/v1/chat/completions"),
                api_key: "test-key".to_string(),
                model: "test-model".to_string(),
                timeout_ms: 5_000,
                response_format: "json_object".to_string(),
                batch_size: 1,
                batch_char_limit: 0,
                batch_window_multiplier: 4,
                overwrite_existing_translations: false,
                concurrency: 1,
                prompts: PromptConfig {
                    ast: String::new(),
                    regex: String::new(),
                    theme: String::new(),
                },
            },
            checkpoint_key: "plugin:translate".to_string(),
            concurrency: 1,
            completed_resources: None,
            processed_items: None,
            total_items: Some(1),
        };

        let result = handle_batch_translate(&state, task.clone(), batch, true).await;

        assert!(result.is_err());
        let record = load_record(&paths);
        let failures = record.get("failures").and_then(Value::as_array).unwrap();
        assert_eq!(failures.len(), 1);
        assert_eq!(
            failures[0].get("sourceId").and_then(Value::as_str),
            Some(source_id)
        );
        assert_eq!(
            failures[0].get("batchType").and_then(Value::as_str),
            Some("regex")
        );
        assert_eq!(
            failures[0]
                .get("items")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        let _ = fs::remove_dir_all(base_path);
    }

    #[tokio::test]
    async fn large_plugin_batch_translate_flushes_translation_file_after_each_concurrency_group() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (first_group_tx, mut first_group_rx) = mpsc::channel::<u64>(2);
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let release_rx = Arc::new(Mutex::new(Some(release_rx)));

        tokio::spawn(async move {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let first_group_tx = first_group_tx.clone();
                let release_rx = release_rx.clone();
                tokio::spawn(async move {
                    let request = read_test_http_request(&mut stream).await;
                    let id = request_item_id(&request);
                    if id >= 2 {
                        if let Some(rx) = release_rx.lock().await.take() {
                            let _ = rx.await;
                        }
                    }
                    let content = format!("{{\"items\":[{{\"i\":{},\"t\":\"译文{}\"}}]}}", id, id);
                    let body = json!({
                        "choices": [{
                            "message": { "content": content },
                            "finish_reason": "stop"
                        }]
                    })
                    .to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    if id < 2 {
                        let _ = first_group_tx.send(id).await;
                    }
                });
            }
        });

        let base_path = env::temp_dir().join(format!("i18n-large-plugin-flush-{}", nanoid!()));
        let paths = paths(base_path.to_str().unwrap());
        let source_id = "source-a";
        let items = (0..4)
            .map(|index| json!({ "source": format!("Source {index}"), "target": format!("Source {index}") }))
            .collect::<Vec<_>>();
        let translation_json = json!({
            "schemaVersion": 1,
            "metadata": {
                "plugin": "plugin-a",
                "title": "Large Plugin",
                "version": "1.0.0",
                "supportedVersions": "1.0.0",
                "language": "zh-cn"
            },
            "dict": {
                "main.js": {
                    "ast": [],
                    "regex": items
                }
            }
        });
        write_json_pretty(
            &paths.meta_path,
            &json!({
                "schemaVersion": 2,
                "sources": {
                    source_id: {
                        "id": source_id,
                        "plugin": "plugin-a",
                        "title": "Large Plugin",
                        "type": "plugin",
                        "origin": "local",
                        "isActive": true,
                        "checksum": "",
                        "translationVersion": "1.0.0",
                        "translationFormatValid": true,
                        "totalTranslationCount": 4,
                        "pendingTranslationCount": 4,
                        "translatedEntryCount": 0,
                        "processedTranslationCount": 0,
                        "unprocessedTranslationCount": 4,
                        "translationProcessingComplete": false,
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                }
            }),
        )
        .unwrap();
        save_translation(&paths, source_id, &translation_json).unwrap();
        let source_file = paths.sources_dir.join(format!("{source_id}.json"));
        let initial_mtime = fs::metadata(&source_file).unwrap().modified().unwrap();

        let state = AppState {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            diagnose_sessions: Arc::new(Mutex::new(HashMap::new())),
            persistence_lock: Arc::new(Mutex::new(())),
            plugin_dir: base_path.clone(),
            http: reqwest::Client::new(),
            shutdown: Arc::new(Mutex::new(None)),
        };
        let task = Arc::new(TaskRuntime {
            progress: Mutex::new(CompanionTaskProgress {
                task_id: "task".to_string(),
                scope: "plugin".to_string(),
                mode: "translate".to_string(),
                status: "running".to_string(),
                current_label: String::new(),
                processed_resources: 0,
                total_resources: 1,
                processed_items: 0,
                total_items: 4,
                success_count: 0,
                failed_count: 0,
                skipped_count: 0,
                source_revision: 0,
                record_revision: 0,
                updated_at: 0,
                error: None,
            }),
            cancel_requested: Mutex::new(false),
        });
        let batch = PluginBatchTranslatePayload {
            persistence: PersistenceConfig {
                base_path: base_path.to_string_lossy().to_string(),
            },
            resources: vec![CompanionBatchResource {
                resource_id: "plugin-a".to_string(),
                label: "Large Plugin".to_string(),
                source_id: Some(source_id.to_string()),
            }],
            config: CompanionTranslationConfig {
                chat_completions_url: format!("http://{addr}/v1/chat/completions"),
                api_key: "test-key".to_string(),
                model: "test-model".to_string(),
                timeout_ms: 5_000,
                response_format: "json_object".to_string(),
                batch_size: 1,
                batch_char_limit: 0,
                batch_window_multiplier: 4,
                overwrite_existing_translations: false,
                concurrency: 2,
                prompts: PromptConfig {
                    ast: String::new(),
                    regex: String::new(),
                    theme: String::new(),
                },
            },
            checkpoint_key: "plugin:translate".to_string(),
            concurrency: 1,
            completed_resources: None,
            processed_items: None,
            total_items: Some(4),
        };
        let task_handle = tokio::spawn({
            let state = state.clone();
            let task = task.clone();
            async move { handle_batch_translate(&state, task, batch, true).await }
        });

        let _ = tokio_timeout(TokioDuration::from_secs(2), first_group_rx.recv())
            .await
            .unwrap()
            .unwrap();
        let _ = tokio_timeout(TokioDuration::from_secs(2), first_group_rx.recv())
            .await
            .unwrap()
            .unwrap();

        tokio_timeout(TokioDuration::from_secs(2), async {
            loop {
                let saved = read_translation(&paths, source_id).unwrap();
                let first = saved
                    .pointer("/dict/main.js/regex/0/target")
                    .and_then(Value::as_str);
                let second = saved
                    .pointer("/dict/main.js/regex/1/target")
                    .and_then(Value::as_str);
                let modified = fs::metadata(&source_file).unwrap().modified().unwrap();
                if first == Some("译文0") && second == Some("译文1") && modified > initial_mtime {
                    break;
                }
                sleep(TokioDuration::from_millis(20)).await;
            }
        })
        .await
        .expect("large plugin translations should flush to source file before the whole window completes");

        let _ = release_tx.send(());
        task_handle.await.unwrap().unwrap();

        let saved = read_translation(&paths, source_id).unwrap();
        assert_eq!(
            saved.pointer("/dict/main.js/regex/3/target").and_then(Value::as_str),
            Some("译文3")
        );
        let _ = fs::remove_dir_all(base_path);
    }

    #[test]
    fn packed_response_marks_non_empty_returned_items_successful_even_if_unchanged() {
        let batch = vec![
            json!({ "id": 1, "resourceStateIndex": 0, "dictIndex": 0, "source": "A", "target": "" }),
            json!({ "id": 2, "resourceStateIndex": 0, "dictIndex": 1, "source": "B", "target": "" }),
            json!({ "id": 3, "resourceStateIndex": 1, "dictIndex": 2, "source": "C", "target": "" }),
            json!({ "id": 4, "resourceStateIndex": 1, "dictIndex": 3, "source": "D", "target": "" }),
        ];
        let translated = vec![
            TranslationPair { i: 1, t: "甲".to_string() },
            TranslationPair { i: 2, t: " ".to_string() },
            TranslationPair { i: 4, t: "D".to_string() },
        ];
        let mut report = PackedBatchReport {
            translated_items: Vec::new(),
            failures: Vec::new(),
        };

        merge_successful_packed_response(&mut report, batch, translated);

        assert_eq!(report.translated_items.len(), 2);
        assert_eq!(report.translated_items[0].get("target").and_then(Value::as_str), Some("甲"));
        assert_eq!(report.translated_items[1].get("target").and_then(Value::as_str), Some("D"));
        let failed_items = report.failures.iter().map(|failure| failure.items.len()).sum::<usize>();
        assert_eq!(failed_items, 2);
        assert!(report.failures.iter().any(|failure| failure.resource_state_index == 0));
        assert!(report.failures.iter().any(|failure| failure.resource_state_index == 1));
    }

    #[test]
    fn retry_window_collects_only_requested_items_and_keeps_remaining_failures() {
        let failures = vec![
            BatchTaskFailureRecord {
                id: "failure-a".to_string(),
                scope: "plugin".to_string(),
                resource_id: "plugin-a".to_string(),
                resource_label: "Plugin A".to_string(),
                source_id: "source-a".to_string(),
                batch_type: "regex".to_string(),
                error_message: "first".to_string(),
                items: vec![
                    BatchTaskFailureItem {
                        source: "A".to_string(),
                        target: String::new(),
                        dict_index: 0,
                        file: Some("main.js".to_string()),
                        r#type: None,
                        name: None,
                    },
                    BatchTaskFailureItem {
                        source: "B".to_string(),
                        target: String::new(),
                        dict_index: 1,
                        file: Some("main.js".to_string()),
                        r#type: None,
                        name: None,
                    },
                ],
                failed_at: 1,
            },
            BatchTaskFailureRecord {
                id: "failure-b".to_string(),
                scope: "plugin".to_string(),
                resource_id: "plugin-b".to_string(),
                resource_label: "Plugin B".to_string(),
                source_id: "source-b".to_string(),
                batch_type: "regex".to_string(),
                error_message: "second".to_string(),
                items: vec![BatchTaskFailureItem {
                    source: "C".to_string(),
                    target: String::new(),
                    dict_index: 0,
                    file: Some("main.js".to_string()),
                    r#type: None,
                    name: None,
                }],
                failed_at: 2,
            },
        ];

        let window = collect_failure_retry_window(&failures, 2);

        assert_eq!(window.len(), 1);
        assert_eq!(window[0].id, "failure-a");
        assert_eq!(window[0].items.len(), 2);
    }

    #[test]
    fn removing_retry_success_items_keeps_unfinished_failure_records() {
        let mut record = json!({
            "schemaVersion": 1,
            "checkpoints": {},
            "failures": [{
                "id": "failure-a",
                "scope": "plugin",
                "resourceId": "plugin-a",
                "resourceLabel": "Plugin A",
                "sourceId": "source-a",
                "batchType": "regex",
                "errorMessage": "failed",
                "items": [
                    { "source": "A", "target": "", "dictIndex": 0, "file": "main.js" },
                    { "source": "B", "target": "", "dictIndex": 1, "file": "main.js" }
                ],
                "failedAt": 1
            }],
            "successBatches": [],
            "updatedAt": 0
        });
        let completed = vec![RetryCompletedItemKey {
            failure_id: "failure-a".to_string(),
            dict_index: 0,
            file: Some("main.js".to_string()),
            batch_type: "regex".to_string(),
        }];

        let removed_failure_ids =
            remove_completed_retry_items_from_record(&mut record, "plugin", &completed);

        let failures = record.get("failures").and_then(Value::as_array).unwrap();
        assert_eq!(failures.len(), 1);
        assert!(removed_failure_ids.is_empty());
        let items = failures[0].get("items").and_then(Value::as_array).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("dictIndex").and_then(Value::as_i64), Some(1));

        let completed = vec![RetryCompletedItemKey {
            failure_id: "failure-a".to_string(),
            dict_index: 1,
            file: Some("main.js".to_string()),
            batch_type: "regex".to_string(),
        }];

        let removed_failure_ids =
            remove_completed_retry_items_from_record(&mut record, "plugin", &completed);

        assert_eq!(removed_failure_ids, vec!["failure-a".to_string()]);
        let failures = record.get("failures").and_then(Value::as_array).unwrap();
        assert!(failures.is_empty());
    }

    #[test]
    fn plugin_retry_counts_attempted_items_when_batch_fails() {
        let result: Result<Vec<Value>> = Err(anyhow!("AI offline"));
        let mut updates = Vec::new();
        let mut processed_items = 0usize;
        let mut completed_ids = Vec::new();
        let mut failed_ids = Vec::new();
        let failure_item_counts = HashMap::from([
            ("failure-a".to_string(), 2usize),
            ("failure-b".to_string(), 1usize),
        ]);

        apply_plugin_retry_result(
            result,
            "regex",
            &mut updates,
            &mut processed_items,
            &mut completed_ids,
            &mut failed_ids,
            &failure_item_counts,
        )
        .unwrap();

        assert_eq!(processed_items, 3);
        assert!(updates.is_empty());
        assert!(completed_ids.is_empty());
        assert!(failed_ids.contains(&"failure-a".to_string()));
        assert!(failed_ids.contains(&"failure-b".to_string()));
    }

    #[tokio::test]
    async fn failure_retry_missing_translation_advances_item_progress() {
        let base_path = env::temp_dir().join(format!("i18n-retry-progress-{}", nanoid!()));
        let paths = paths(base_path.to_str().unwrap());
        write_json_pretty(
            &paths.batch_task_record_path,
            &json!({
                "schemaVersion": 1,
                "checkpoints": {},
                "failures": [{
                    "id": "failure-a",
                    "scope": "plugin",
                    "resourceId": "plugin-a",
                    "resourceLabel": "Plugin A",
                    "sourceId": "missing-source",
                    "batchType": "regex",
                    "errorMessage": "failed",
                    "items": [
                        { "source": "A", "target": "", "dictIndex": 0, "file": "main.js" },
                        { "source": "B", "target": "", "dictIndex": 1, "file": "main.js" }
                    ],
                    "failedAt": 1
                }],
                "successBatches": [],
                "updatedAt": 0
            }),
        )
        .unwrap();
        let state = AppState {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            diagnose_sessions: Arc::new(Mutex::new(HashMap::new())),
            persistence_lock: Arc::new(Mutex::new(())),
            plugin_dir: base_path.clone(),
            http: reqwest::Client::new(),
            shutdown: Arc::new(Mutex::new(None)),
        };
        let task = Arc::new(TaskRuntime {
            progress: Mutex::new(CompanionTaskProgress {
                task_id: "task".to_string(),
                scope: "plugin".to_string(),
                mode: "translate".to_string(),
                status: "running".to_string(),
                current_label: String::new(),
                processed_resources: 0,
                total_resources: 1,
                processed_items: 0,
                total_items: 2,
                success_count: 0,
                failed_count: 0,
                skipped_count: 0,
                source_revision: 0,
                record_revision: 0,
                updated_at: 0,
                error: None,
            }),
            cancel_requested: Mutex::new(false),
        });
        let payload = json!({
            "persistence": { "basePath": base_path.to_string_lossy() },
            "config": {
                "chatCompletionsUrl": "http://127.0.0.1",
                "apiKey": "test",
                "model": "test",
                "timeoutMs": 1000,
                "responseFormat": "json_object",
                "batchSize": 2,
                "batchCharLimit": 0,
                "overwriteExistingTranslations": false,
                "concurrency": 1,
                "prompts": { "ast": "", "regex": "", "theme": "" }
            },
            "concurrency": 1,
            "totalResources": 1,
            "totalItems": 2
        });

        handle_failure_retry(&state, task.clone(), payload, true)
            .await
            .unwrap();

        let progress = task.progress.lock().await.clone();
        assert_eq!(progress.processed_items, 2);
        assert_eq!(progress.processed_resources, 1);
        assert_eq!(progress.skipped_count, 1);
        let _ = fs::remove_dir_all(base_path);
    }
    #[tokio::test]
    async fn requesting_cancel_keeps_task_running_until_worker_exits() {
        let task = Arc::new(TaskRuntime {
            progress: Mutex::new(CompanionTaskProgress {
                task_id: "task".to_string(),
                scope: "plugin".to_string(),
                mode: "translate".to_string(),
                status: "running".to_string(),
                current_label: "Batch".to_string(),
                processed_resources: 0,
                total_resources: 1,
                processed_items: 0,
                total_items: 1,
                success_count: 0,
                failed_count: 0,
                skipped_count: 0,
                source_revision: 0,
                record_revision: 0,
                updated_at: 0,
                error: None,
            }),
            cancel_requested: Mutex::new(false),
        });

        request_task_cancel(&task).await;

        assert!(*task.cancel_requested.lock().await);
        let progress = task.progress.lock().await.clone();
        assert_eq!(progress.status, "running");
        assert_eq!(progress.current_label, "正在停止");
    }
    #[tokio::test]
    async fn translate_value_batches_waits_for_in_flight_requests_after_batch_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (slow_status_tx, mut slow_status_rx) = mpsc::channel::<bool>(1);

        tokio::spawn(async move {
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                let slow_status_tx = slow_status_tx.clone();
                tokio::spawn(async move {
                    serve_translate_value_batch_test_request(stream, slow_status_tx).await;
                });
            }
        });

        let config = CompanionTranslationConfig {
            chat_completions_url: format!("http://{addr}/v1/chat/completions"),
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
            timeout_ms: 5_000,
            response_format: "json_object".to_string(),
            batch_size: 1,
            batch_char_limit: 0,
            batch_window_multiplier: 4,
            overwrite_existing_translations: false,
            concurrency: 2,
            prompts: PromptConfig {
                ast: String::new(),
                regex: String::new(),
                theme: String::new(),
            },
        };

        let result = translate_value_batches(
            &[
                json!({ "id": 0, "source": "bad" }),
                json!({ "id": 1, "source": "slow" }),
            ],
            "prompt",
            &config,
            |item| json!({ "i": item["id"], "s": item["source"] }),
            None,
        )
        .await;

        assert!(result.is_err());
        let slow_request_was_cancelled =
            tokio_timeout(TokioDuration::from_secs(2), slow_status_rx.recv())
                .await
                .unwrap()
                .unwrap();
        assert!(
            !slow_request_was_cancelled,
            "a failed sibling batch should not abort an in-flight streaming request"
        );
    }

    #[tokio::test]
    async fn translate_packed_batches_stops_scheduling_new_batches_after_failure_threshold() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let request_count = Arc::new(Mutex::new(0usize));
        let server_request_count = request_count.clone();

        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let server_request_count = server_request_count.clone();
                tokio::spawn(async move {
                    let request = read_test_http_request(&mut stream).await;
                    let id = request_item_id(&request);
                    *server_request_count.lock().await += 1;
                    if id >= 2 {
                        sleep(TokioDuration::from_millis(250)).await;
                    }
                    let content = if id < 2 {
                        "{\"items\":[{\"i\":0,\"t\":\"\"}]}"
                    } else {
                        "{\"items\":[{\"i\":2,\"t\":\"译文2\"}]}"
                    };
                    let body = json!({
                        "choices": [{
                            "message": { "content": content },
                            "finish_reason": "stop"
                        }]
                    })
                    .to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });

        let base_path = env::temp_dir().join(format!("i18n-no-new-batches-after-threshold-{}", nanoid!()));
        let paths = paths(base_path.to_str().unwrap());
        let state = AppState {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            diagnose_sessions: Arc::new(Mutex::new(HashMap::new())),
            persistence_lock: Arc::new(Mutex::new(())),
            plugin_dir: base_path.clone(),
            http: reqwest::Client::new(),
            shutdown: Arc::new(Mutex::new(None)),
        };
        let mut resource_states = vec![BatchResourceState {
            original_index: 0,
            resource: CompanionBatchResource {
                resource_id: "plugin-a".to_string(),
                label: "Plugin A".to_string(),
                source_id: Some("source-a".to_string()),
            },
            source_id: "source-a".to_string(),
            translation_json: json!({
                "schemaVersion": 1,
                "metadata": { "plugin": "plugin-a", "title": "Plugin A", "version": "1.0.0" },
                "dict": { "main.js": { "ast": [], "regex": [] } }
            }),
            processed_items: 0,
            dirty: false,
            all_items: Vec::new(),
            pending_items: Vec::new(),
            success_items: Vec::new(),
            failures: Vec::new(),
        }];
        let items = (0..4)
            .map(|id| json!({
                "id": id,
                "resourceStateIndex": 0,
                "file": "main.js",
                "dictIndex": id,
                "source": format!("Source {id}"),
                "target": ""
            }))
            .collect::<Vec<_>>();
        let config = CompanionTranslationConfig {
            chat_completions_url: format!("http://{addr}/v1/chat/completions"),
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
            timeout_ms: 5_000,
            response_format: "json_object".to_string(),
            batch_size: 1,
            batch_char_limit: 0,
            batch_window_multiplier: 4,
            overwrite_existing_translations: false,
            concurrency: 2,
            prompts: PromptConfig {
                ast: String::new(),
                regex: String::new(),
                theme: String::new(),
            },
        };

        let report = translate_packed_batches(
            &items,
            &mut resource_states,
            "prompt",
            &config,
            |item| json!({ "i": item["id"], "s": item["source"] }),
            PackedBatchRuntime {
                state: &state,
                paths: &paths,
                batch_type: "regex",
                is_plugin: true,
                flush_every_batches: config.concurrency,
            },
            None,
        )
        .await
        .unwrap();

        assert_eq!(packed_report_failed_item_count(&report), 2);
        assert_eq!(*request_count.lock().await, 3);
        let _ = fs::remove_dir_all(base_path);
    }

    #[tokio::test]
    async fn translate_packed_batches_replenishes_requests_inside_window() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (request_tx, mut request_rx) = mpsc::channel::<u64>(3);
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let release_rx = Arc::new(Mutex::new(Some(release_rx)));

        tokio::spawn(async move {
            for _ in 0..3 {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let request_tx = request_tx.clone();
                let release_rx = release_rx.clone();
                tokio::spawn(async move {
                    let request = read_test_http_request(&mut stream).await;
                    let id = request_item_id(&request);
                    let _ = request_tx.send(id).await;
                    if id == 0 {
                        if let Some(rx) = release_rx.lock().await.take() {
                            let _ = rx.await;
                        }
                    }
                    let content = format!("{{\"items\":[{{\"i\":{},\"t\":\"译文{}\"}}]}}", id, id);
                    let body = json!({
                        "choices": [{
                            "message": { "content": content },
                            "finish_reason": "stop"
                        }]
                    })
                    .to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });

        let base_path = env::temp_dir().join(format!("i18n-replenish-requests-{}", nanoid!()));
        let paths = paths(base_path.to_str().unwrap());
        let state = AppState {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            diagnose_sessions: Arc::new(Mutex::new(HashMap::new())),
            persistence_lock: Arc::new(Mutex::new(())),
            plugin_dir: base_path.clone(),
            http: reqwest::Client::new(),
            shutdown: Arc::new(Mutex::new(None)),
        };
        let mut resource_states = vec![BatchResourceState {
            original_index: 0,
            resource: CompanionBatchResource {
                resource_id: "plugin-a".to_string(),
                label: "Plugin A".to_string(),
                source_id: Some("source-a".to_string()),
            },
            source_id: "source-a".to_string(),
            translation_json: json!({
                "schemaVersion": 1,
                "metadata": { "plugin": "plugin-a", "title": "Plugin A", "version": "1.0.0" },
                "dict": { "main.js": { "ast": [], "regex": [] } }
            }),
            processed_items: 0,
            dirty: false,
            all_items: Vec::new(),
            pending_items: Vec::new(),
            success_items: Vec::new(),
            failures: Vec::new(),
        }];
        let items = (0..3)
            .map(|id| json!({
                "id": id,
                "resourceStateIndex": 0,
                "file": "main.js",
                "dictIndex": id,
                "source": format!("Source {id}"),
                "target": ""
            }))
            .collect::<Vec<_>>();
        let config = CompanionTranslationConfig {
            chat_completions_url: format!("http://{addr}/v1/chat/completions"),
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
            timeout_ms: 5_000,
            response_format: "json_object".to_string(),
            batch_size: 1,
            batch_char_limit: 0,
            batch_window_multiplier: 4,
            overwrite_existing_translations: false,
            concurrency: 2,
            prompts: PromptConfig {
                ast: String::new(),
                regex: String::new(),
                theme: String::new(),
            },
        };
        let task_handle = tokio::spawn({
            let state = state.clone();
            let paths = paths.clone();
            async move {
                translate_packed_batches(
                    &items,
                    &mut resource_states,
                    "",
                    &config,
                    |item| json!({ "i": item["id"], "s": item["source"] }),
                    PackedBatchRuntime {
                        state: &state,
                        paths: &paths,
                        batch_type: "regex",
                        is_plugin: true,
                        flush_every_batches: config.concurrency,
                    },
                    None,
                )
                .await
            }
        });

        let _ = tokio_timeout(TokioDuration::from_secs(2), request_rx.recv()).await.unwrap().unwrap();
        let _ = tokio_timeout(TokioDuration::from_secs(2), request_rx.recv()).await.unwrap().unwrap();
        let third_arrived_before_release = tokio_timeout(TokioDuration::from_millis(300), request_rx.recv()).await.ok().flatten().is_some();
        let _ = release_tx.send(());
        task_handle.await.unwrap().unwrap();

        assert!(
            third_arrived_before_release,
            "a completed request should be replenished before the whole concurrency group finishes"
        );
        let _ = fs::remove_dir_all(base_path);
    }

    #[test]
    fn plugin_apply_translation_can_apply_only_ast_or_regex() {
        let base_path = env::temp_dir().join(format!("i18n-apply-kind-switches-{}", nanoid!()));
        let plugin_dir = base_path.join("plugin");
        let backup_base_path = base_path.join("plugin-data");
        fs::create_dir_all(&plugin_dir).unwrap();
        let file_path = plugin_dir.join("main.js");
        let source_code = r#"const title = "Hello"; console.log("World");"#;
        fs::write(&file_path, source_code).unwrap();
        let translation_json = json!({
            "schemaVersion": 1,
            "metadata": {
                "plugin": "plugin-a",
                "title": "Plugin A",
                "version": "1.0.0"
            },
            "dict": {
                "main.js": {
                    "ast": [
                        { "type": "VariableDeclarator", "name": "title", "source": "Hello", "target": "你好" }
                    ],
                    "regex": [
                        { "source": "World", "target": "世界" }
                    ]
                }
            }
        });

        apply_plugin_translation_blocking(PluginApplyTranslationPayload {
            plugin_id: "plugin-a".to_string(),
            plugin_dir: plugin_dir.to_string_lossy().to_string(),
            backup_base_path: backup_base_path.to_string_lossy().to_string(),
            translation_json: Some(translation_json.clone()),
            persistence: None,
            translation_source_id: None,
            apply_ast: Some(true),
            apply_regex: Some(false),
        })
        .unwrap();
        let ast_only = fs::read_to_string(&file_path).unwrap();
        assert!(ast_only.contains("你好"));
        assert!(ast_only.contains("World"));
        assert!(!ast_only.contains("世界"));

        fs::write(&file_path, source_code).unwrap();
        fs::remove_dir_all(backup_dir(backup_base_path.to_str().unwrap())).unwrap();

        apply_plugin_translation_blocking(PluginApplyTranslationPayload {
            plugin_id: "plugin-a".to_string(),
            plugin_dir: plugin_dir.to_string_lossy().to_string(),
            backup_base_path: backup_base_path.to_string_lossy().to_string(),
            translation_json: Some(translation_json),
            persistence: None,
            translation_source_id: None,
            apply_ast: Some(false),
            apply_regex: Some(true),
        })
        .unwrap();
        let regex_only = fs::read_to_string(&file_path).unwrap();
        assert!(regex_only.contains("Hello"));
        assert!(!regex_only.contains("你好"));
        assert!(regex_only.contains("世界"));

        let _ = fs::remove_dir_all(base_path);
    }
    async fn serve_translate_value_batch_test_request(
        mut stream: tokio::net::TcpStream,
        slow_status_tx: mpsc::Sender<bool>,
    ) {
        let request = read_test_http_request(&mut stream).await;
        let id = request_item_id(&request);
        if id == 0 {
            let event = json!({
                "choices": [{ "delta": { "content": "{\"items\":[{\"i\":0,\"t\":\"\"}]}" }, "finish_reason": "stop" }]
            });
            let _ = stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\ndata: {}\n\ndata: [DONE]\n\n",
                        event
                    )
                    .as_bytes(),
                )
                .await;
            return;
        }

        if stream
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
            )
            .await
            .is_err()
        {
            let _ = slow_status_tx.send(true).await;
            return;
        }
        let first_event = json!({
            "choices": [{ "delta": { "content": "{\"items\":[" } }]
        });
        if stream
            .write_all(format!("data: {}\n\n", first_event).as_bytes())
            .await
            .is_err()
        {
            let _ = slow_status_tx.send(true).await;
            return;
        }
        let _ = stream.flush().await;

        let mut probe = [0u8; 1];
        let cancelled_before_finish = tokio::select! {
            read = stream.read(&mut probe) => matches!(read, Ok(0) | Err(_)),
            _ = sleep(TokioDuration::from_millis(250)) => false,
        };
        if cancelled_before_finish {
            let _ = slow_status_tx.send(true).await;
            return;
        }

        let second_event = json!({
            "choices": [{ "delta": { "content": "{\"i\":1,\"t\":\"乙\"}]}" }, "finish_reason": "stop" }]
        });
        let write_failed = stream
            .write_all(format!("data: {}\n\ndata: [DONE]\n\n", second_event).as_bytes())
            .await
            .is_err();
        let _ = slow_status_tx.send(write_failed).await;
    }

    async fn read_test_http_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let read = stream.read(&mut chunk).await.unwrap();
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(header_end) = find_header_end(&buffer) {
                let headers = String::from_utf8_lossy(&buffer[..header_end]).to_string();
                let content_length = headers
                    .lines()
                    .find_map(|line| line.split_once(':'))
                    .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buffer.len() >= header_end + 4 + content_length {
                    break;
                }
            }
        }
        String::from_utf8(buffer).unwrap()
    }

    fn find_header_end(buffer: &[u8]) -> Option<usize> {
        buffer.windows(4).position(|window| window == b"\r\n\r\n")
    }

    fn request_item_id(request: &str) -> u64 {
        let body = request.split("\r\n\r\n").nth(1).unwrap_or_default();
        let payload: Value = serde_json::from_str(body).unwrap();
        let content = payload
            .pointer("/messages/1/content")
            .and_then(Value::as_str)
            .unwrap();
        let items: Vec<Value> = serde_json::from_str(content).unwrap();
        items
            .first()
            .and_then(|item| item.get("i"))
            .and_then(Value::as_u64)
            .unwrap()
    }
    #[test]
    fn translate_checkpoint_keeps_unfinished_resources_when_stopped_mid_window() {
        let resources = vec![
            json!({ "resourceId": "done", "label": "Done", "sourceId": "source-done" }),
            json!({ "resourceId": "pending-a", "label": "Pending A", "sourceId": "source-a" }),
            json!({ "resourceId": "pending-b", "label": "Pending B", "sourceId": "source-b" }),
        ];
        let completed = HashSet::from([0usize]);
        let progress = CompanionTaskProgress {
            task_id: "task".to_string(),
            scope: "plugin".to_string(),
            mode: "translate".to_string(),
            status: "running".to_string(),
            current_label: "正在停止".to_string(),
            processed_resources: 1,
            total_resources: 3,
            processed_items: 2,
            total_items: 6,
            success_count: 1,
            failed_count: 0,
            skipped_count: 0,
            source_revision: 0,
            record_revision: 0,
            updated_at: 0,
            error: None,
        };

        let checkpoint = create_checkpoint("plugin", "translate", &resources, &completed, &progress);

        assert_eq!(checkpoint.completed_resources, 1);
        assert_eq!(checkpoint.processed_items, 2);
        assert_eq!(checkpoint.resources.len(), 2);
        assert_eq!(checkpoint.resources[0].resource_id, "pending-a");
        assert_eq!(checkpoint.resources[1].resource_id, "pending-b");
    }

    #[tokio::test]
    async fn ai_timeout_allows_body_to_finish_after_first_chunk() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request_buffer = vec![0u8; 4096];
            let _ = stream.read(&mut request_buffer).await.unwrap();

            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            let first_event = json!({
                "choices": [{ "delta": { "content": "{\"items\":[" } }]
            });
            stream
                .write_all(format!("data: {}\n\n", first_event).as_bytes())
                .await
                .unwrap();
            stream.flush().await.unwrap();

            sleep(TokioDuration::from_millis(1_100)).await;

            let second_event = json!({
                "choices": [{ "delta": { "content": "{\"i\":1,\"t\":\"甲\"}]}" }, "finish_reason": "stop" }]
            });
            stream
                .write_all(format!("data: {}\n\ndata: [DONE]\n\n", second_event).as_bytes())
                .await
                .unwrap();
        });

        let config = CompanionTranslationConfig {
            chat_completions_url: format!("http://{addr}/v1/chat/completions"),
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
            timeout_ms: 80,
            response_format: "json_object".to_string(),
            batch_size: 1,
            batch_char_limit: 0,
            batch_window_multiplier: 4,
            overwrite_existing_translations: false,
            concurrency: 1,
            prompts: PromptConfig {
                ast: String::new(),
                regex: String::new(),
                theme: String::new(),
            },
        };

        let translated = call_chat_completion(&[json!({ "i": 1, "s": "A" })], "prompt", &config)
            .await
            .unwrap();

        assert_eq!(translated.len(), 1);
        assert_eq!(translated[0].i, 1);
        assert_eq!(translated[0].t, "甲");
    }

    #[tokio::test]
    async fn ai_timeout_treats_reasoning_as_activity_before_content() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request_buffer = vec![0u8; 4096];
            let _ = stream.read(&mut request_buffer).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            let reasoning_event = json!({
                "choices": [{ "delta": { "reasoning_content": "thinking" } }]
            });
            stream
                .write_all(format!("data: {}\n\n", reasoning_event).as_bytes())
                .await
                .unwrap();
            stream.flush().await.unwrap();

            sleep(TokioDuration::from_millis(1_100)).await;

            let content_event = json!({
                "choices": [{ "delta": { "content": "{\"items\":[{\"i\":1,\"t\":\"甲\"}]}" }, "finish_reason": "stop" }]
            });
            let _ = stream
                .write_all(format!("data: {}\n\ndata: [DONE]\n\n", content_event).as_bytes())
                .await;
        });

        let config = CompanionTranslationConfig {
            chat_completions_url: format!("http://{addr}/v1/chat/completions"),
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
            timeout_ms: 80,
            response_format: "json_object".to_string(),
            batch_size: 1,
            batch_char_limit: 0,
            batch_window_multiplier: 4,
            overwrite_existing_translations: false,
            concurrency: 1,
            prompts: PromptConfig {
                ast: String::new(),
                regex: String::new(),
                theme: String::new(),
            },
        };

        let translated = call_chat_completion(&[json!({ "i": 1, "s": "A" })], "prompt", &config)
            .await
            .unwrap();

        assert_eq!(translated.len(), 1);
        assert_eq!(translated[0].i, 1);
        assert_eq!(translated[0].t, "甲");
    }
}
