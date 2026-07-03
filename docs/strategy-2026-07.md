# hawky 戰略計畫書（2026-07-03）

---

## 1. 總評（優點與缺點的誠實總結）

### 優點：內核是 staff 級工程，時機正確

- **Agent loop 的紀律極佳。** History-invariant 設計（`src/agent/loop.ts:661-694` 每條失敗路徑都合成對應 tool_result、`normalize.ts` 的 fixToolPairing 修復）讓「tool_use 無 tool_result 導致 400」這類 bug 在結構上難以重現；stop-reason 採白名單（`SAFE_TOOL_STOP_REASONS`）而非黑名單，是正確的防禦性設計。
- **Safe-bash 是真工程，不是 regex 直覺。** Fail-closed parser、word-boundary 前綴比對、curl/find 的結構化 argv 分析器（`tool_executor.ts:610-776`），每條排除都有威脅推理註解。
- **記憶檢索管線設計成熟。** SQLite FTS5 BM25 + 向量混合、hash 增量同步、限定 daily log 的 temporal decay、CJK-aware MMR 重排（`src/memory/hybrid.ts`），純函式抽取且測試密集。
- **測試文化是實的。** 實測 4,724 個 unit test 全綠（README 還低報成 ~2,200）、133 個 integration test；iOS 有 7,200+ LOC 設計良好的測試與 TESTING.md 三層測試架構；web 有 601 個真實測試案例。
- **註解考古品質罕見地高。** 幾乎每個非直覺決策都有 why-comment 與 issue 編號（如 `LiveSessionStore.swift:104-117` 的 per-token re-render 修復、`compaction.ts:115-138` 的 surrogate-pair 切片理由）。
- **方向押對了。** 2025-26 年 OpenAI Scheduled Tasks、Gemini Proactive Assistance、Alexa+ Daily Insights、Meta/Google 眼鏡全部收斂到 `src/ambient/` 已建模的東西——proactive help + moment-of-need activation。品類已被驗證。

### 缺點：外殼與縫隙嚴重落後於內核

- **今天沒有任何人裝得起來。** Repo 是 private（hao-ai-lab/hawky，3 stars）、`npm view hawky` 回 E404、README 與 `install.sh:7` 指向不存在的 `zhisbug/hawky`、**沒有 LICENSE 檔**（package.json `files[]` 卻列了 LICENSE）——法律上這是 all-rights-reserved，不是開源專案。轉換率由建構決定為 0%。
- **差異化賣點目前很薄。** Latent recognition 只會鑄造一種意圖：`buy X`（`latent-recognizer.ts:203` 硬編 `` `buy ${rawItem}` ``，model prompt 第 360 行明令使用 "buy <item>" 格式）；delivery gate 是永遠回 `score:1` 的 stub、directive mode 在所有 production 路徑不可達（`intention-service.ts:194` 傳 `scoreCtx: undefined`）；三種 mode 收斂為一個 boolean。註：**明確式 when-reminder 路徑是完整可用的**（arming/fire/durable store/boot rehydration），所以正確描述是「proactive reminders 能用，latent 引擎還是雛形」，而非全盤 vaporware。
- **同意工程（consent engineering）不存在，而這是宣稱的護城河。** Cocktail-party **臉部**辨識（注意：是 face，不是 voice——repo 內沒有任何 voiceprint 程式碼）會把未同意的陌生人自動 enroll 成 "Unknown"（`CocktailPartyRecognizer.swift:210-220`）；deepface sidecar 在確認比對時 mutation-on-read 增長 embedding（`app.py:287-294`，上限 12 筆）；iOS 全域關閉 ATS（`project.yml:70`）；demo 畫面把 OpenAI key 存明文 UserDefaults；部署的官網漏掉 privacy.html（`deploy_modal.py:15-20`）。
- **協定層從未被建造。** `protocol.ts` 只 type 信封，77 個 gateway method（不是先前估的 40）全靠 `params as {...}` 內聯轉型；client 端到處 `as any`，已產生真實出貨 bug（background ask_user 監聽錯事件名，靜默丟棄提示）。四個 client codebase、四份 byte-identical lib 檔、三份跨端 stream 狀態機 + web 內部再重複一份。
- **CI/發布是可信度負債。** 無 macOS job（iOS 測試 gate 不了任何東西）、web-ios/pytest 不跑、e2e main-only 且 continue-on-error、`release.yml` 對任何 v* tag 直接 npm publish 零測試門檻、bun-version: latest、無任何 lint。
- **記憶會自毀。** 全域 consolidation 每 6 小時把 MEMORY.md 截到 16k → Haiku 2048-token 重寫 → 無備份無條件覆蓋（`distill.ts:252,288,302`）；daily distillation 摘要長 session 的**開頭**而非結尾。
- **God modules 遍地。** `tool_executor.ts` 1,467 行、`agent-methods.ts` 2,602 行、web `session-store.ts` 2,793 行、iOS `LiveSessionStore.swift` 4,905 行 251 個方法。

一句話總評：**hawky 是一個穿著 ambient-agent 外衣、內核優秀的 agent runtime；它的問題不是能力而是完成度與封裝——而修這些的成本，大多數以「天」和「週」計。**

---

## 2. hawky 的未來發展（12-18 個月 Roadmap）

### Phase 0：發射前封鎖項（第 0-1 個月）——「Week Zero Package」

沒做完這些，其他一切都是零：

1. **法律與身份**：加 MIT/Apache-2.0 LICENSE + package.json 的 license/repository/engines 欄位；repo 轉 public；統一 org 為 hao-ai-lab/hawky（README、install.sh、release skill）；發布 npm（`hawky` 名字還空著是運氣，會過期）。
2. **一鍵安裝**：`bunx hawky` 或 curl|sh 完成 gateway 自啟 + TUI + 印出 web URL + BYOK wizard。`--auto` 已存在（`src/index.ts:111,195`）但 README 沒寫——先修文件，再補 first-run wizard。
3. **README 重新定位**：README 目前對 ambient/glasses/camera/voice **零提及**（grep 只命中 7 次 "heartbeat"），Project Structure 漏掉 `src/ambient/`、`src/identity/`、`web-ios/`、`ios/`、`services/`。官網（"Hawk — Ambient AI Agent"）其實講對了故事，但五個 demo 影片是 placeholder——把 repo 門面對齊官網。
4. **信任急救**（上 HN 前必修）：
   - Headless 權限收斂：headless（cron/heartbeat/sub-agent）目前會自動核准 permissioned tools——`write_file`/`edit_file` 可寫任意路徑、bash 只要不中 ~17 條 dangerous regex 就放行（safe allowlist 失敗只是設 needsPermission，隨後落入 auto-approve 路徑，`tool_executor.ts:1337-1363`）。公允地說：curl 已被限縮到 GET-only/Slack 讀端點、`permissions.deny` 優先、`ask` 規則在 headless 會 deny、且有獨立 dangerous floor 覆寫 allow 規則——但對一個以 headless 為常態的 always-on agent，正確設計是**與互動模式相同的 fail-closed allowlist + per-lane capability grant**（heartbeat 只能寫 workspace_dir）。
   - iOS：移除全域 `NSAllowsArbitraryLoads`（改 `NSAllowsLocalNetworking`）；demo store 的明文 API key 改 Keychain 或整組移出 release target。
   - 臉部辨識預設 OFF，移除 Unknown 自動 enroll。
   - 官網補上 privacy.html（deploy_modal.py 一行修復）。
5. **速修 bug**：dead watchers（chokidar v5 移除 glob，`skills/watcher.ts:61` 與 `memory/index.ts:762` 監看不存在的字面路徑，skills hot-reload 整個死掉）；HAWKY_HOME split-brain（把 dc5c222 補齊到全部七個 module）；`when-cron.ts:40-49` 的 setTimeout overflow（>24.8 天的提醒立即觸發）。

### Phase 1：信任與可靠性（第 1-4 個月）

- **Consent engine v1**（旗艦功能，見第 10 節）：enrollment-gated 辨識、unknown 匿名 diarization、per-person 刪除、retention TTL、capture ledger、無法抑制的錄製指示器。
- **@hawky/protocol 真正變成 package**：schema-first（zod/TypeBox）定義全部 77 個 method 與 event payload，生成 TS bindings 與 Swift Codable，gateway dispatch 邊界驗證。ask_user 事件名這類 bug 變成編譯錯誤。
- **CI matrix**：core / web / web-ios / python sidecar / iOS（macos runner 跑 `xcodegen && xcodebuild test`）；pin bun 版本、`--frozen-lockfile`、去掉 `--retry=2` 並修掉 `Bun.sleep(10)` 競態測試；發布管線改成 tag → 版本一致性檢查 → 全 matrix → `npm publish --provenance` → changelog.sh。
- **記憶不再自毀**：consolidation 改 merge/append + timestamped backup + fact-retention 檢查；daily distillation 摘要 session 尾部。
- **Reminder 基本盤**：recurrence（採現成 scheduling library，順便換掉 when-resolver 的手刻雙語 regex）、where-region boot rehydration、satisfaction 判定併入既有 per-tick LLM call（廢除 stop-word regex sweep——現在 'the/for/got' 都算 topic，能永久誤刪真提醒）。
- **Intentions Hub**（web/iOS/TUI）：列出所有 armed/surfaced intention 附出處（「你週二說的」）、一鍵 snooze/edit/delete/un-suppress。這是 OpenAI Pulse 停辦教訓的直接落地。
- **Gateway hardening**（修正後的正確定位——medium 級補強而非 critical 漏洞，因為多用戶隔離已由 per-user process + 各自 OS user + 各自 HMAC signing key 提供）：token 已含 jti，補一個 jti revocation denylist；authenticated RPC dispatch 加 per-connection rate limit（media/chat/control 分開預算）；`permission.resolve` 的 sequential requestId 改隨機並綁 session。

### Phase 2：Ambient v2 與客戶端整併（第 4-9 個月）

- **統一 trigger-state evaluator**：每個 term（when/where/latent-topic）向 durable store 回報 satisfied/unsatisfied——一次刪掉 in-memory conjunction latch、composite-trigger 拒絕（`create-intention.ts:80-85`）、surfaceLatent vs fireIntention 分叉。
- **意圖分類擴展**：一個 batched per-tick LLM call 同時處理鑄造/滿足/相關性，涵蓋對話中承諾、follow-up、約會、期限、耗盡補貨。delivery gate 真正接上 mode/context，或砍掉 modes.ts/delivery-gate.ts 的架構劇場。
- **Hybrid inference**：本地 VAD/ASR/salience（Ollama/MLX/Apple Foundation Models），雲端只在候選時刻觸發；Gemini Live 作為 realtime 語音第二路由（vendored pipecat 已有路徑；價差 ~50x）。發布「cost per ambient day」數字。
- **Monorepo 整併**：Bun workspaces（packages/protocol、client-core、realtime）；**把 web-ios 併入 web/**（四個 lib 檔 byte-identical，本質是樣式變體）；抽出框架無關的 RealtimeSession class 取代 LiveLab.tsx/useRealtime.ts 雙實作。
- **Server-owned session semantics**：session.history 補 tool status/metadata/batch id；新增第一級 tool-record message type，**刪除 TOOL_MARKER**（目前 web-ios 用隱形 unicode 把最多 600KB base64 塞進 assistant message，在 web/TUI 渲染成垃圾）；順便刪掉 client 端 ~400 行推斷 heuristics。
- Event delivery：per-session 單調 seq + bounded replay buffer 或明確 gap 訊號（取代全域 seq + 靜默丟棄）。

### Phase 3：生態與規模（第 9-18 個月）

- **τ-Voice benchmark repo + leaderboard**（記憶中已有方向）：量測 false-positive interruption cost、latency-to-interject、proactive-recall precision——業界沒人量這個。每次 frontier model 發布 48 小時內更新（Aider 模式）。
- **Skills 生態**：文件化 plugin 平台、種 10-20 個範例 skill（含 Home Assistant 整合，順便借他們的社群）、hackathon + bounty（Omi 模式）；換掉手刻 frontmatter parser 以相容標準 SKILL.md 格式。
- **硬體不可知擴張**：TestFlight 發布、Omi necklace/ESP32 接入、Android XR 開放時跟進——hawky 是「任何會聽會看的硬體背後的開放 runtime」。
- **Open-core 商業化探索**：hosted relay、managed memory、行動便利層（Plaud/screenpipe/Omi 已驗證模式）；OSS 核心永遠完整可用。

---

## 3. Ambient Agent 領域的未來發展（引用研究來源）

**品類在 2025-26 收斂完成，2027-28 進入執行品質競爭：**

1. **Proactive UX 的定論已出。** OpenAI 2025-09 推出 ChatGPT Pulse（https://openai.com/index/introducing-chatgpt-pulse/），2026-06-17 宣布停辦、併入 Scheduled Tasks，官方教訓：proactive 體驗必須「personalized, action-oriented, and steerable」（https://help.openai.com/en/articles/12293630-chatgpt-pulse）。不可操控的 feed 死掉，使用者主導的 scheduled/monitoring task 活下來——這直接規定了 hawky Intentions Hub 的設計。
2. **眼鏡是突破性終端。** Meta AI glasses 2025 年賣出 7M+ 副、Ray-Ban Display（$799）需求強到暫停國際擴張（https://www.cnbc.com/2026/02/11/ray-ban-maker-essilorluxottica-triples-sales-of-meta-ai-glasses.html）；Google I/O 2026 宣布 Gemini 智慧眼鏡兩階（音訊款 2026 秋出貨，https://blog.google/products-and-platforms/platforms/android/android-xr-io-2026/）；IDC 預測無螢幕智慧眼鏡 2026 年 ~13.6M 副、2030 年 27.3M（https://www.idc.com/resource-center/blog/smart-glasses-surge-the-xr-market-is-rewriting-its-own-rules/）。兩大生態都是封閉的——開放 runtime 是空位。
3. **平台全面收斂到 proactive。** Alexa+ 對全美 Prime 免費開放並內建 Daily Insights（https://www.aboutamazon.com/news/devices/new-alexa-generative-artificial-intelligence）；Apple 以 ~$1B/年採用 Gemini 重建 Siri，proactive Siri 預期 iOS 27（https://www.cnbc.com/2026/01/12/apple-google-ai-siri-gemini.html）；Gemini app 推 Proactive Assistance（https://9to5google.com/2026/04/27/gemini-proactive-assistance/）。
4. **獨立 always-listening 硬體被大廠吞併。** Meta 收購 Limitless（2025-12-05）並遠端停用裝置、放棄 EU/UK 用戶（https://techcrunch.com/2025/12/05/meta-acquires-ai-device-startup-limitless/）；Amazon 收購 Bee（https://techcrunch.com/2026/01/12/why-amazon-bought-bee-an-ai-wearable/）；OpenAI 的 io 裝置（screenless、always-sensing）最早 2027-02（https://www.macrumors.com/2026/02/20/jony-ive-openai-smart-speaker-2027/）。被遺棄的用戶群是 hawky 的現成受眾。
5. **On-device 推理跨過門檻。** ~35 TOPS NPU 可跑 4B 模型，最佳實務是 hybrid——edge SLM 處理高頻低延遲、雲端處理 frontier 推理；always-on 工作負載的邊際成本趨近零（https://www.edge-ai-vision.com/2026/01/on-device-llms-in-2026-what-changed-what-matters-whats-next/）。
6. **Realtime 語音商品化且價差巨大。** GPT-Realtime-2（2026-05）vs Gemini 3.1 Flash Live：每 10 萬分鐘 ~$8,400 vs ~$165（https://www.justthink.ai/compare/openai-realtime-vs-gemini-live-api）。傳輸層（LiveKit、Pipecat——後者已是 NVIDIA blueprint，https://www.daily.co/blog/daily-and-nvidia-collaborate-to-simplify-voice-agents-at-scale/）在商品化，差異化上移到記憶、proactivity、多模態脈絡。
7. **市場規模與死亡率並存。** Gartner：agentic AI 支出 2026 年 +141% 至 $201.9B，但 >40% 專案將在 2027 年底前因成本/價值不明/風險控制不足被砍（https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027）——這正是 benchmark 可量測價值的論據。
8. **法律風險加速。** Wiretap 訴訟 2021→2025 從 2 件到 30 件（https://news.bloomberglaw.com/litigation/wiretap-suits-pit-old-privacy-laws-against-new-ai-technology）；EU AI Act 2026-08-02 全面生效，Art. 5/50 無開源豁免（https://artificialintelligenceact.eu/article/5/）。

**2027-28 的 table stakes**（綜合上述來源）：跨裝置持久記憶（可檢視可編輯）、可操控的 scheduled+monitoring tasks、亞秒級可打斷語音、相機/眼鏡視覺脈絡、hybrid edge/cloud 路由、consent-aware capture、能行動（訂/寄/寫）而非只通知。hawky 的 roadmap 應以此為驗收清單。

---

## 4. 如何讓更多人使用（具體、可執行）

1. **60 秒 first-run 是最高優先工程項。** 34.7% 的開發者因安裝困難放棄工具——高於所有其他原因（https://www.catchyagency.com/post/what-202-open-source-developers-taught-us-about-tool-adoption）。目標：`bunx hawky` → gateway 背景自啟 → TUI 開啟 → 印出 web URL → BYOK wizard → 預埋一個 demo intention，讓使用者 60 秒內體驗一次 proactive surface。KPI：**minutes-to-first-proactive-suggestion**。
2. **瀏覽器麥克風 demo mode。** 現在的 wow 路徑要價 >$500、>2 小時（從源碼建 iOS app + 實體 iPhone + Ray-Ban Meta + Tailscale，見 docs/onboarding-guide.md）。web-ios 的 Live pipeline 已會抓瀏覽器麥克風——把 ambient demo 做進 web/，零硬體兩分鐘見效。
3. **TestFlight。** 眼鏡用戶不該需要 Xcode。
4. **收留被遺棄者。** 做 Limitless/Bee/Rewind 資料匯入路徑，官網明說：「你的 life-log 不該能被收購或遠端關停。」
5. **修 README 事實。** 死連結（tests/MANUAL_TESTS.md 不存在）、低報 2 倍的測試數、缺一半子系統的 project map——改成 CI 生成或刪除手寫數字，加 broken-link 檢查。
6. **社群表面從零建起。**（目前 .github/ 只有 workflows/）：Discord、CONTRIBUTING.md、SECURITY.md、issue/PR templates、CODEOWNERS；從審計的 techDebt 清單直接開 20-30 個 good first issue（重複的 classifyError、dead prepaint.ts、formatDate 重複——完美的第一題）。
7. **競品矩陣進 README。** 「唯一結合 realtime audio + camera + glasses + proactive、可自架的開源專案」：OpenClaw 無感知層、screenpipe 桌面限定且被動、Omi cloud-first、Khoj 純文字、HA 限智慧家庭——這個矩陣沒人能反駁，該印在門面上。
8. **量正確的東西。** Gateway activations、weekly active devices、skills published——不是 stars 和流量。

---

## 5. 推廣策略（具體管道與行動，引用 Growth Playbook 研究）

**節奏：連續新聞週期，不是單次發布**（OpenClaw 0→250K stars 四個月、Aider/OpenHands 的持久引擎都是複利式，https://newsletter.pragmaticengineer.com/p/the-creator-of-clawd-i-ship-code）：

- **Cycle 1（發射週）**：45-90 秒 demo 影片（hawky 聽到「咖啡沒了」→ 在超市附近的手機上浮出提醒）置頂 README + X + Show HN 同步。Show HN 規範（https://business.daily.dev/resources/hacker-news-marketing-developer-tools-show-hn-launch-day-sustained-coverage/）：標題帶具體數字（「interjects in <900ms, TypeScript/Bun」）、無最高級、週二至週四上午 ET、創辦人第一小時內回每則留言、README 準備好承受 5K-50K 訪客（~1.4 star/upvote）。同週開 Discord。**前提：headless 權限與 consent 已修——HN 讀者第一天就會 audit 一個 always-listening agent 的程式碼，第一則置頂留言就是你的發射評語。**
- **Cycle 2**：τ-Voice benchmark/leaderboard 獨立 repo 上線，先公布 hawky 自己的數字**包括輸的項目**。Aider 靠幾小時內評測新模型讓 leaderboard 變成習慣性流量（https://aider.chat/docs/leaderboards/）；OpenHands 靠 SWE-bench + ICLR 論文建立可信度（https://arxiv.org/abs/2407.16741）。hawky 量的是沒人量的：誤打擾率。
- **Cycle 3**：skills hackathon + bounty（Omi 模式：便宜 dev kit、250+ 社群 app、付費貢獻獎金，https://omi.devpost.com/）+ iOS TestFlight。
- **週期之間**：深度工程文（gateway 設計、cocktail-party 的 on-device 隱私切分、prompt caching 的 10x 成本槓桿）——教育性內容，不是宣傳文。

**管道原則**（失敗文獻高度一致，https://draft.dev/learn/everything-ive-learned-about-devtools-marketing）：不做 paid ads、gated content、email nurture、outbound。做 docs、社群、無摩擦 first-run。**Influencer program 而非 campaign**：給 5-10 個 local-AI/agent 領域 YouTuber/X 創作者早期存取，每人一個不同的 demo 場景（https://plug.dev/blog/influencer-playbook）。

**定位借力**：
- **Home Assistant 模式**：local-first/privacy 作為身份而非功能；非程式碼貢獻（翻譯、測試、skill 作者）一級公民——HA 靠這個做到單年 21K 貢獻者（https://github.blog/open-source/maintainers/the-local-first-rebellion-how-home-assistant-became-the-most-important-project-in-your-house/）。
- **TypeScript 時刻**：Octoverse 2025 顯示 TS 已是 GitHub 第一語言、gen-AI 專案月貢獻者近三倍成長（https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/）——明確標榜「TypeScript 生態的 ambient agent runtime」。
- **真實性護城河**：Continue 的 PearAI 事件證明「verifiably genuine OSS」是持久信譽（https://ai.miraheze.org/wiki/Continue_Dev）。OSS 核心無登入牆、human-attribution commit policy 公開可見、簽章發布。

---

## 6. 競爭對手分析

### 大廠

| 對手 | 現狀 | 對 hawky 的威脅 | 對 hawky 的機會 |
|---|---|---|---|
| **OpenAI** | Pulse 停辦→Scheduled Tasks；GPT-Realtime-2 API；io 裝置（~2027-02） | io 裝置直接對打「always sensing」品類；Realtime API 品質標竿 | Pulse 的失敗是免費教材；io 是封閉硬體——hawky 是「開源的 io 裝置替代」定位現成；GPT-Realtime-2 是 hawky 可用的元件 |
| **Google** | Gemini Proactive Assistance、Gemini Live、Android XR 眼鏡（2026 秋） | 全端整合（Gmail/Calendar/眼鏡/裝置端加密處理）+ 免費分發 | 全部鎖 Google 生態；Gemini Live 的 50x 價格優勢是 hawky 的成本槓桿而非威脅——當供應商用 |
| **Meta** | Ray-Ban 7M+ 副、Display $799 供不應求；吞了 Limitless 並遠端停用裝置 | 擁有眼鏡分發管道；封閉 runtime | Limitless kill-switch 是 hawky 最強的行銷論據；Meta 眼鏡用戶想要開放後端 |
| **Amazon** | Alexa+ 對 200M+ Prime 免費、Daily Insights、agentic 行動；吞了 Bee | 免費 + 家庭場景滲透率 | 家庭外（隨身/眼鏡/工作）Alexa 無故事；被 Bee 收購驚嚇的用戶可收留 |
| **Apple** | Siri 延到 iOS 26.4/27，底層改用 Gemini | 平台守門人（App Review 2.5.14 是硬約束） | 落後者；hawky 的 iOS app + on-device Foundation Models 可以先到 |

### 新創

- **Plaud**（~$250M ARR、獲利）：證明硬體 + 訂閱可行，但是純錄音筆記，無 proactive/agent 層——商業模式參考而非對手。
- **Omi**（MIT stack、~10K stars、聲稱 300K 用戶）：最接近的開源可穿戴，但 cloud-first、proactive 引擎薄。**機會：把 Omi 硬體當 hawky 的 client。**
- **Friend**（3,000 台、惡評如潮）：反面教材——粗糙的 proactive 人格會主動趕走用戶，印證精準度>召回率。
- **screenpipe**（YC S26）：本地 screen+audio 24/7，但桌面限定、被動。部分重疊，可互補。

### 開源

- **OpenClaw**（250K+ stars，史上最快）：proactivity/skills/MCP/多通道齊全但**無感知層**。威脅：吸走「self-hosted personal agent」心智。機會：相容其 skills/MCP、把 hawky 定位為互補的感知層；抄它的分發打法。
- **Khoj**（34K stars）：second brain + scheduled automation，純文字。
- **Home Assistant**：智慧家庭限定；是盟友與整合對象（借社群）而非對手。
- **LiveKit / Pipecat**：基礎設施層，**組合而非競爭**——hawky 已 vendor pipecat；保持 gateway 與其 transport/MCP 互通。
- **Open Interpreter / OVOS / Leon**：維護動能弱或限 voice-command，非直接威脅。

**結論：空位真實存在且可命名**——「開源、可自架、audio+camera+glasses 感知 + proactive 遞送」四項同時成立的專案是零。但視窗在 2026-27 收窄（Gemini Proactive、Alexa+、Siri、io 全在收斂），hawky 的持久護城河只有：self-hosting、model-agnostic（三 provider 已就位）、hackability（skills/MCP/HAWKY.md）、跨表面（TUI/web/iOS/glasses）。投資這四項，不要跟大廠打拋光戰。

---

## 7. 現有缺點是否可解（逐項）

| # | 缺點 | 可解性 | 怎麼解 | 工作量 |
|---|---|---|---|---|
| 1 | 無 LICENSE / repo private / npm 404 / 安裝 URL 死 | **可解（純執行）** | 見 Phase 0 | 2 天 |
| 2 | README 隱藏產品定位 | **可解** | 重寫門面 + demo 影片 + 競品矩陣 | 數天 |
| 3 | Latent 引擎只認 "buy X"、delivery gate stub | **可解但是最大的產品工程** | Batched LLM call 統一鑄造/滿足/gate + 意圖分類擴展 + 統一 trigger evaluator | 數月 |
| 4 | Consent engineering 不存在（臉部自動 enroll 等） | **可解，且是差異化投資** | Consent engine（第 10 節）；先做「預設 OFF + 移除 Unknown enroll」止血（天級），完整版月級 | 週→月 |
| 5 | Headless 權限過寬 | **可解** | Fail-closed allowlist + per-lane capability grants；併入 tool_executor 政策管線重寫。注意修正後的定性：不是「只有 regex 防線」（allowlist/deny 優先/curl 限縮等層已存在），但 write/edit 任意路徑自動核准是真的 | 數週 |
| 6 | Device token 無 per-token 撤銷、RPC 無 rate limit | **可解（修正後為 medium 級）** | jti denylist（jti 已在 payload 裡）+ dispatchMethod quota middleware + 隨機化 permission requestId。多用戶隔離已由 per-user process/OS user/HMAC key 提供，不需重寫身份層 | 天→週 |
| 7 | 協定無型別、77 method 全 `as any` | **可解** | @hawky/protocol schema-first package + codegen | 數週 |
| 8 | 四客戶端重複（byte-identical libs、多份狀態機、雙 WebRTC 管線） | **可解** | Bun workspaces + client-core + 併掉 web-ios + RealtimeSession 抽取 | 數週 |
| 9 | setTimeout overflow / 無 recurrence / where 不 rehydrate / regex satisfaction sweep | **可解** | Overflow chunking（天）、scheduling library（週）、boot rehydration（天）、satisfaction 併入 LLM call（週） | 天→週 |
| 10 | MEMORY.md 破壞性 consolidation | **可解** | 備份 + merge/append + retention check | 數週 |
| 11 | Dead watchers（chokidar v5） | **可解** | 監看目錄 + 檔名過濾 + 真實整合測試 | 數天 |
| 12 | CI 缺口（iOS/web-ios/pytest 不跑、release 無門檻） | **可解** | Job matrix + gated release | 數天 |
| 13 | God modules（tool_executor / session-store / agent-methods / LiveSessionStore） | **可解但需紀律** | 見第 9 節 | 週→月/個 |
| 14 | Always-on 雲端成本經濟學 | **難解（架構性）** | Hybrid edge/cloud 是唯一路徑；本地 VAD/ASR/salience 過濾 + Gemini Live 便宜路由。做得到，但是持續的架構工作，不是一次修復 | 數月起 |
| 15 | Proactive 精準度（誤打擾） | **難解（產品本質難題）** | 沒有純工程解——Pulse 和 Friend 都栽在這。防線：steerability（Intentions Hub）、precision-over-recall、benchmark 化量測誤打擾率、silence-by-default | 持續 |
| 16 | 跨轄區法律合規（BIPA/EU AI Act/全員同意州） | **難解（外部約束）** | 無法「解決」，只能工程化最壞轄區預設 + RESPONSIBLE_USE.md + consent engine。永久營運成本 | 持續 |
| 17 | 平台依賴（App Store、Meta/Google 封閉眼鏡） | **部分難解** | App Store：嚴格合規 2.5.14 可解；封閉眼鏡 runtime：無解，繞道——支援開放硬體並等 Android XR 開放 | 持續 |

**總結：17 項中 13 項是「純執行、天到月級」；只有 4 項（成本、精準度、法律、平台）是本質難題，且都有已知的緩解策略。這個專案沒有無解的病，只有沒排的刀。**

---

## 8. 技術債清單（按償還優先序）

**P0——正在造成錯誤行為或即將造成：**
1. Dead watchers：`skills/watcher.ts:61,65`、`memory/index.ts:762` 的 chokidar v5 glob 迴歸（skills hot-reload 全死、root .md 編輯不觸發 reindex）；零測試覆蓋真實 watcher。
2. HAWKY_HOME split-brain：七個 module 硬編 `~/.hawky`（session.ts:70、workspace.ts:26、skills/loader.ts:35、input-history.ts:13 等）；dc5c222 只修了一半且不在 HEAD。
3. `when-cron.ts` setTimeout overflow + `latent-service.ts:286-315` regex satisfaction sweep（不可逆誤刪）。
4. MemoryIndex.sync() 在 SQLite 寫交易中 await 網路（`index.ts:146-181`）且無 mutex——gateway 4 路併發下必炸，靜默降級成 grep。
5. Skill env 注入 mutate 全域 `process.env`（`skills/env.ts:50-93`）——併發 run 之間的 secret 洩漏，必須改 per-run env 傳給 Bun.spawn。

**P1——每天在收乘法稅的重複：**
6. Stream-event 狀態機 3 份跨端（TUI hook、web session-store、iOS ChatEvent.swift）+ web 內部 active/background/parseHistory 三份——每個修復要打 4 次。
7. 四個 byte-identical lib 檔（ws-client/byok/client-id/media）+ socket-store 已出現行為漂移（token 清除）。
8. MCP tool-bridge 有損 schema 轉換（`tool-bridge.ts:53-64` 丟掉 items/nested/anyOf）——直接透傳原 JSON Schema 即可。
9. McpServerManager：header 宣稱 reconnect + health monitoring，兩者皆不存在；無 streamable-HTTP transport。
10. 重複的 classifyError（anthropic/openai provider 各 ~70 行）、session key 轉換 x3、formatDate x2、tool-preview 格式化 x4、slash-command 系統 x2。

**P2——死代碼與腐爛面：**
11. iOS：`OpenAIRealtimeLiveSessionProvider` ~830 行死 provider + 死 hook 接線；~5,000 行 demo/lab stores（含明文 key）；`prepaint.ts`/staticBaseline/`decideDelivery`/transcript-relay.ts/`src/services/` 四個空 stub。
12. TOOL_MARKER 協定濫用（gateway message type 落地後刪）。
13. Provider capability 補丁：OpenAI provider 送 `max_tokens`（新模型要 `max_completion_tokens`）、無 reasoning 支援、chars/4 countTokens；document block 讓含 PDF 的 session 換 provider 後永久失敗——一個 ProviderCapabilities descriptor 收攏。
14. 三份模型註冊表（context-window/openai-models/cost-tracker）無單一事實來源。

**P3——品質基建：**
15. 無任何 lint/format（64k LOC TS + Swift 41.5k + Python）：biome + ruff + SwiftLint 入 CI。
16. Meta-tests 是 string-grep 而非行為測試（test-release-packaging.ts）——改跑真 `npm pack --dry-run`。
17. `Bun.sleep(10)` 競態測試 ~20 處 + `Math.random()` 選 port——`--retry=2` 正在遮蔽它們。
18. 記憶體效能債：embeddings 存 JSON text O(corpus) 解析、FTS 嚴格 AND 無 stemming 且 CJK 壞、listSessions O(全部 bytes)；deepface sidecar 全檔 JSON 重寫 + O(N×M) 掃描。
19. 五套測試命名慣例、孤兒測試資產（eval-relevance-gate、gemini-live-smoke 無 runner）。

---

## 9. 需要大翻新的部分（嚴厲直說）

1. **`tool_executor.ts`（1,467 行）——重寫。** 一個檔案塞了 permission cache、pattern 規則、靜態 allowlist、curl/find 分析器、路徑 containment、mode 邏輯和三階段執行器，最終核准決策是五個互相糾纏的 boolean 加兩份幾乎相同的 headless floor。滿檔的「Codex round 2/7/8/9/12 P1/P2」註解就是診斷書：**這不是被設計出來的政策引擎，是被 12 輪對抗性審查打成的補丁山。** 翻新後：一條有序政策管線（deny > ask > explicit-allow > safe-static > prompt）回傳單一 typed decision，bash/curl/find 分析器獨立成 command-policy module，headless 用同一條管線 + per-lane grants。
2. **web `session-store.ts`（2,793 行）——重寫。** 模組級可變全域（自稱 "Legacy aliases"）跟 per-session Map 並存，switchSession 手動在兩者之間抄資料——漏抄一次就是跨 session 串流污染。active/background 兩台 ~350 行近重複狀態機已經漂移出貨過 bug。tool-status reclassifier 三代規則各自出貨又壞掉。**這個檔案在跟自己打架。** 翻新後：per-session state slice + 一個 reducer，active 只是指標；解析/格式化外移。
3. **iOS `LiveSessionStore.swift`（4,905 行、251 個方法）——重寫。** 15 個不相關關注點的 god object：phase machine、transcript、Live Activity、widget、CoreLocation、cocktail party、錄音、中斷恢復、持久化全在裡面，核心狀態機實際上只能 e2e 測。**每個新功能都往這裡倒，它已經是 iOS app 的單點崩壞源。** 拆成 session-lifecycle、transcript store、diagnostics、ambient/region coordinator、activity coordinator。
4. **Ambient delivery 層（delivery.ts / delivery-gate.ts / modes.ts）——實作或刪除，不准維持現狀。** `decideDelivery` 是死代碼、`scoreDelivery` 是常數 stub、唯一有意義的分支（directive）在所有 production 路徑不可達、三種 mode 投影成一個 boolean。**三層抽象包一個 boolean，比一個 boolean 更糟——這是架構劇場。** 要嘛把 ScoreContext 真正接進 IntentionService/LatentService，要嘛刪掉兩層。
5. **Latent recognizer 的 regex 側——汰換。** 用 LLM 鑄造、用 stop-word 級 regex 銷毀（'the'/'for'/'got' 都算 topic 的 satisfaction sweep 可以永久 suppress 真需求）——**風險分配整個顛倒**。satisfaction 併入本來就在跑的 per-tick model call，regex 降級為候選過濾器或直接刪。
6. **`when-resolver.ts`（308 行手刻雙語時間 regex）——汰換。** 已知 DST day-roll 缺陷、不支援 noon/tonight/in 2 days、餵給一個有 setTimeout overflow 的 scheduler、無 recurrence。**Realtime model 已經能吐 ISO——收緊工具契約為 ISO-or-clarify，或採用現成 recurrence library。手刻這個沒有任何回報。**
7. **web-ios 作為獨立 app——淘汰。** 四個 lib 檔 byte-identical、依賴 90% 重疊、兩個 bun.lock、兩份 node_modules。**它是一個響應式樣式變體，不是一個產品。** 併入 web/ platform flag。
8. **iOS demo/lab stores（~5,000 行）——逐出 production target。** 三套重疊實驗 harness 出現在正式 app 的 Settings 和 tab 裡，複製 mic-pump 邏輯、把 API key 存明文 UserDefaults、塞滿 asyncAfter timing hack。**實驗品出貨給用戶是紀律問題，不是技術問題。** Dev-only target 或刪除。
9. **McpServerManager——重寫。** 檔案 header 寫著「reconnect on crash」「health monitoring」，**檔案裡兩者都不存在**——stdio server 死掉後所有 bridged tool 失敗到 gateway 重啟，getAllStates() 還回報 connected。加上只支援已棄用的 SSE 而無 streamable-HTTP。這是說謊的抽象。
10. **`ReconnectingTransport.swift`——改名或改行為。** 名字叫 Reconnecting，實際只 retry 初次連線；socket 中途死掉時 pump 靜默退出，重連推給每個 caller（NodeRunner 自己又實作了一套 backoff）。**App 最重要的一條鏈路，被一個名不符實的抽象邊界守著。**
11. **Release pipeline——重寫。** 任何 v* tag 直接 npm publish，零測試、零版本一致性檢查、零 provenance，且與自家 release skill 的規範互相矛盾（兩套流程，不同 changelog、不同 repo 名）。**對一個賣「verifiable self-hosted」的專案，未驗證發布是自我否定。**
12. **`frontmatter.ts` 手刻 YAML parser——汰換。** 逼出「JSON-string-in-YAML metadata」這種只有自家 parser 看得懂的慣例，CRLF 就壞，並封死與標準 Agent-Skills SKILL.md 格式的相容性——**在 skills 生態是成長引擎的前提下，這是自斷經脈。**

---

## 10. 風險（隱私/法律/平台）與必要防線

### 風險盤點

1. **生物特徵責任（最高法律風險）。** Cocktail-party **臉部**辨識目前自動 enroll 未同意的路人（`CocktailPartyRecognizer.swift:210-220`），deepface DB 存 512 維 embedding + 臉部裁切 JPEG，且無 per-person 刪除端點（只有整庫 /clear）。這落在 BIPA 臉部幾何理論（Patel v. Facebook 系；Clearview 和解 $51.75M）與 GDPR Art. 9 特殊類別資料。**修正說明：這是 face 而非 voiceprint——repo 內沒有聲紋辨識程式碼，Cruz v. Fireflies.AI 的聲紋理論不直接適用，但同意缺口本身完全成立。** 美國 ~23 州有生物特徵法（TX CUBI 由 AG 執法，Meta 賠了 $1.4B）。（https://www.privacyworld.blog/2025/12/2025-year-in-review-biometric-privacy-litigation/、https://stateofsurveillance.org/guides/basic/23-states-biometric-privacy-laws/）
2. **竊聽/全員同意法。** ~13 州要求全員同意；always-on 裝置無人看管時從一方同意滑向第三方竊聽（聯邦重罪）；AI wiretap 訴訟 2021→2025 成長 15 倍。（https://www.recordinglaw.com/us-laws/ai-meeting-recording-laws/、https://www.techtimes.com/articles/319380/20260630/ai-voice-recorder-raises-11m-using-it-without-consent-felony-these-states.htm）
3. **EU AI Act（2026-08-02 全面生效）。** Art. 5 禁止以非定向抓取建立臉部辨識資料庫、職場/學校情緒推斷——**無開源豁免**；Art. 50 要求對暴露於生物特徵分類系統的人首次接觸即告知，罰則至 €15M 或 3% 全球營收；開源豁免在專案商業化後整個消失。（https://artificialintelligenceact.eu/article/5/、https://artificialintelligenceact.eu/article/50/、https://linuxfoundation.eu/newsroom/ai-act-explainer）
4. **GDPR 控制者地位。** 家用豁免在裝置於家庭外捕捉路人資料時失效——使用者可能成為 data controller，hawky 作為軟體提供者可能成為 joint controller。（https://www.sciencedirect.com/science/article/pii/S026736492200036X）
5. **App Store 平台風險。** Guideline 2.5.14 要求錄製時明確同意 + 清晰視覺/聽覺指示；5.1.2(vi) 禁止臉部映射資料用於行銷/data mining；隱私政策必須可達——而部署的官網目前 404 自己的 privacy.html。全域 `NSAllowsArbitraryLoads` 也需要向審查說明。無隱蔽背景錄製路徑可走。（https://developer.apple.com/app-store/review/guidelines/）
6. **平台/生態風險。** Meta/Google 眼鏡 runtime 封閉；provider 依賴（內部 wire format 為 Anthropic-canonical——保留但需 ProviderCapabilities 正式化）；Bun lock-in 未受管理（CI 用 latest、bun:sqlite 擋住 sqlite-vec）——接受 Bun 但 pin 版本並把 Bun API 隔離在薄 runtime module 後面。
7. **安全姿態風險（修正後定性）。** Gateway 的多用戶隔離是成立的（per-user process + OS user + 各自 HMAC key），token 也非「不可撤銷」（輪換 signing key 可全撤、30 天過期、jti 已存在）；真正的缺口是 **per-token 撤銷、authenticated RPC rate limiting、permission requestId 可猜測**——medium 級 hardening，發射前補上即可，不需恐慌式重寫。Headless 權限（見第 2 節 Phase 0）才是發射前必修的信任邊界。

### 必要防線（工程化，不是免責聲明）

1. **Consent engine 作為 media-ingest 的硬依賴**（Limitless Consent Mode 為藍本，https://help.limitless.ai/en/articles/13004190）：預設只處理已 enroll 的擁有者；偵測到未知人臉/語者時暫停持久化直到明確 opt-in；未 enroll 者永遠匿名 diarize（"Speaker 2"），不建立生物特徵；consent 事件寫入可稽核 ledger。
2. **辨識全面改為 opt-in enrollment**：預設 OFF、移除 Unknown 自動 enroll、`/identify` 改純讀（embedding 增長移到明確 /confirm）、per-person 刪除端點、embedding TTL、存 embedding 不存原圖（可行處）。
3. **最壞轄區預設**：出廠設定在全員同意州合法（指示器開、consent mode 開、未知語者暫停）——讓營運者有意識地放寬，而不是有意識地收緊。
4. **透明度工件**：`docs/RESPONSIBLE_USE.md`（營運者即 GDPR controller / AI Act deployer + 轄區檢查表）、對路人的「跟 hawky 附近的人說話會發生什麼」公開頁、可匯出的 QR/告知文件（Art. 50 合規）、修好 privacy.html 部署。
5. **Local-first 為預設資料路徑**：本地 ASR/辨識選項、無設定不外呼雲端、無預設遙測、`~/.hawky/` 下加密靜態儲存、一鍵完整匯出與刪除、優先存 transcript/衍生事件而非原始音視訊。
6. **可驗證性**：簽章 + provenance 發布、SECURITY.md、gateway hardening 三件套（jti denylist、rate limit、requestId 綁定）、geofenced no-record zones（where-adapter 是現成掛點）與職場/學校 profile（停用任何情緒推斷式功能）。
7. **把防線變成賣點**：Meta 遠端關停 Limitless、Amazon 吞掉 Bee 之後，「你的 life-log 跑在你控制的硬體上，沒有人能收購或關停它」是 Meta/Google/Amazon 在結構上無法複製的唯一主張——**合規工程與行銷主軸在這個品類是同一件事。**

---

*本計畫所有程式碼層級論斷均以子系統審計 + 逐項驗證結果為據；經驗證駁斥或過度陳述的批評（gateway「無授權模型」的 critical 定性、headless「只有 regex 防線」的框架、cocktail-party 為聲紋、memory_search 安全矛盾）已按驗證結論修正呈現。*
