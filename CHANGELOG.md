# Takode Changelog

## [0.47.0](https://github.com/MrVPlusOne/takode/compare/the-companion-v0.46.0...the-companion-v0.47.0) (2026-04-21)


### Features

* **board:** add Wait For column to BoardBlock UI and fix CLI ambiguity (q-90) ([f57e9ac](https://github.com/MrVPlusOne/takode/commit/f57e9ac4bf00a2d5b3375e3daf8612f15cd85d48))
* **board:** extend --wait-for to accept session numbers (#N) (q-219) ([c06a3e0](https://github.com/MrVPlusOne/takode/commit/c06a3e0d733348fe0353ddd4f23ee6caac335c9b))
* **board:** keep completed items in collapsed history section (q-238) ([2fa002d](https://github.com/MrVPlusOne/takode/commit/2fa002d5c736e0c270f128d67ee39a7f58028c74))
* **board:** persistent work board widget at bottom of leader session UI (q-105) ([d79c2bc](https://github.com/MrVPlusOne/takode/commit/d79c2bccfb1f1ea4f9032a48f7313080fb1a3557))
* **board:** stable sort, operation title, and auto-collapse for work board (q-99) ([4f42ce6](https://github.com/MrVPlusOne/takode/commit/4f42ce666233993b7db9deb1485aa8eacbc069ed))
* **bridge:** re-inject leader system prompt after compaction (q-138) ([d4598b5](https://github.com/MrVPlusOne/takode/commit/d4598b53187a196745880c114453a26ff87545df))
* **chat:** link herd event session chips ([0d91905](https://github.com/MrVPlusOne/takode/commit/0d9190582ce0900ce8cae182a2f204c9aba538d2))
* **chat:** make terminal inspector draggable and resizable ([cd45503](https://github.com/MrVPlusOne/takode/commit/cd4550342a302e5b430246cd5767b701d0b881d2))
* **chat:** render timer messages as collapsed event cards ([2209052](https://github.com/MrVPlusOne/takode/commit/220905262e77c114600aeae204fbe9b8b1b838dc))
* **chat:** render user messages with conservative Markdown subset (q-216) ([18a50f1](https://github.com/MrVPlusOne/takode/commit/18a50f1afb4353a177a89623611bca74f0ff29ed))
* **chat:** show sub-conclusions in collapsed leader turns (q-172) ([34d4417](https://github.com/MrVPlusOne/takode/commit/34d4417a2287e1647db4f5ad854d6b2573a459ee))
* **chat:** text selection context menu for assistant messages (q-174) ([66d1628](https://github.com/MrVPlusOne/takode/commit/66d1628dfe4c25038a72b9b949638fe9bd29efa6))
* **cli:** nest reviewer sessions under parent workers in takode list (q-167) ([5fe6ba1](https://github.com/MrVPlusOne/takode/commit/5fe6ba1d858942f1b5cadf64747e2bed7dcf8035))
* **codex:** add mention picker and resume UI ([d579bc5](https://github.com/MrVPlusOne/takode/commit/d579bc5d8e24a11a6e24dbb271bf712d53609c48))
* **codex:** add revert support for session rollback (q-289) ([4cf3b9c](https://github.com/MrVPlusOne/takode/commit/4cf3b9caa60f213e9ec58981ae4878b52fabf437))
* **composer:** autocomplete quest and session refs ([fb91311](https://github.com/MrVPlusOne/takode/commit/fb91311d5e55aecba272849fac79549603296c62))
* **debug:** add [revert] debug logging to revert flow ([19c93b8](https://github.com/MrVPlusOne/takode/commit/19c93b8b1fe2a994a5ababa450948f455220f792))
* **debug:** add browser perf collector ([a66ced7](https://github.com/MrVPlusOne/takode/commit/a66ced7c787415e4abb565e66f10c834b9b9b0c1))
* **herd-events:** compress activity tool noise ([771c482](https://github.com/MrVPlusOne/takode/commit/771c48263743e1d1d0bd4bfaf6c719ad4e1ecc4c))
* **herd:** include plan content in ExitPlanMode herd events (q-215) ([944ca1b](https://github.com/MrVPlusOne/takode/commit/944ca1b64b08c6d9435efcb51f4cfabff8d963a7))
* **herd:** optimize peek format and auto-inject activity into herd events ([8e86d54](https://github.com/MrVPlusOne/takode/commit/8e86d5425a26da8f6eae32fa613bbe43d2d74b36))
* **herd:** show session info after herding (q-192) ([794d584](https://github.com/MrVPlusOne/takode/commit/794d5848b06346e2c08216c856dc0710efd1e208))
* **herd:** tail-priority truncation and Bash description display (q-156) ([cc3e365](https://github.com/MrVPlusOne/takode/commit/cc3e365a7fdb1576c4a252d0b088434b46b3a11d))
* **history:** window hidden sections on demand ([7331c26](https://github.com/MrVPlusOne/takode/commit/7331c2602592476cd1445f0027539200fc2a833e))
* **images:** compress .orig images to JPEG q85 on ingest (q-232) ([5b0ed33](https://github.com/MrVPlusOne/takode/commit/5b0ed33722c8af8dec18784ac6e07ef195d913a1))
* **links:** add session-message deep links with scroll-to-reveal (q-201) ([1e0d6c2](https://github.com/MrVPlusOne/takode/commit/1e0d6c2d74770637011187077cd69518a35e19f3))
* **logging:** implement production logging system (q-299) ([db969f4](https://github.com/MrVPlusOne/takode/commit/db969f45e583b7f016d248c61734f88de049adb3))
* **markdown:** widen table viewer overlay ([1aad8f0](https://github.com/MrVPlusOne/takode/commit/1aad8f0227d65f862aea24e10e6679a1ac92e28d))
* **notifications:** add per-session notification inbox UI (q-235) ([238bf1c](https://github.com/MrVPlusOne/takode/commit/238bf1c35202a95ffa80b153ddc24ecdfad3a5e7))
* **notifications:** add pushover event filters ([cacad04](https://github.com/MrVPlusOne/takode/commit/cacad0417fee1239811c1055a78780849919d0f5))
* **notifications:** color bell by highest urgency ([add5903](https://github.com/MrVPlusOne/takode/commit/add590332c4b351b0762c71d46523a17d1b94839))
* **notifications:** route herded session notifications through leader (q-264) ([5e6ceab](https://github.com/MrVPlusOne/takode/commit/5e6ceab401ad732eb36975d5dd0463fc0933d55e))
* **notifications:** sidebar markers and differentiated sounds (q-251) ([a42c5c4](https://github.com/MrVPlusOne/takode/commit/a42c5c4a94a88aaf2d2410118a1ae19c1d24aac7))
* **orchestration:** add 'no blocking tools' rule to leader guardrails (q-234) ([d1d8319](https://github.com/MrVPlusOne/takode/commit/d1d83192da2960efaf83b914232a1fd83c2db9bd))
* **orchestration:** add 'wait for user answer' rule to leader guardrails (q-240) ([331b0bc](https://github.com/MrVPlusOne/takode/commit/331b0bc06572e064257ae22e261c9f669c0d1398))
* **orchestration:** add notification trigger rules to leader guardrails (q-246) ([2b96d39](https://github.com/MrVPlusOne/takode/commit/2b96d39068b9537e74b90d80693a489bd986f3d7))
* **orchestration:** add pre-submission checklist to quest lifecycle (q-248) ([32a077a](https://github.com/MrVPlusOne/takode/commit/32a077a1e6d848301cc89e59e1e8fee0ad3ff76a))
* **orchestration:** enforce full quest journey with no-skip rules (q-241) ([9833186](https://github.com/MrVPlusOne/takode/commit/9833186212d199a926074681bceff0519860c31e))
* **orchestration:** improve herd event and peek/scan message format (q-245) ([bb44d21](https://github.com/MrVPlusOne/takode/commit/bb44d2119a22977e799442abe91914c7f38efa9e))
* **orchestration:** skip herd events triggered by leader's own actions (q-259) ([5aa3641](https://github.com/MrVPlusOne/takode/commit/5aa3641e6b796dd6b3014d885d0abd6cd8ebe21c))
* **orchestration:** warn on stalled board rows ([3530002](https://github.com/MrVPlusOne/takode/commit/35300028ea6c7d68ae8c81273b83fe0d3b532e85))
* **quest:** add grep-style quest search ([18da151](https://github.com/MrVPlusOne/takode/commit/18da151c879771b1ed6d1cc4a3316c3d94e47b30))
* **quest:** attach synced commits to verification handoff ([a7cebbf](https://github.com/MrVPlusOne/takode/commit/a7cebbf053945175669256db6f98ee9b12fe136f))
* **quest:** enforce summary comments ([130b46c](https://github.com/MrVPlusOne/takode/commit/130b46c0649a79444df8006bb6d75512e5a1b04a))
* **questmaster:** add compact persisted view ([0e39a4e](https://github.com/MrVPlusOne/takode/commit/0e39a4eff62c8b6c7c8f78b27ef19ad013c03bb1))
* **questmaster:** convert status filter to multi-select toggle (q-176) ([5c621ab](https://github.com/MrVPlusOne/takode/commit/5c621ab2610fa4804c39aa52e2bd0d35133644e8))
* **questmaster:** edit and delete agent feedback ([ead0b55](https://github.com/MrVPlusOne/takode/commit/ead0b5539ad68687d0b58ed6e59271f4f7150b51))
* **questmaster:** show commit diff totals ([181d56b](https://github.com/MrVPlusOne/takode/commit/181d56bf2f6f6de21a3fe4b793e2a6fd61c13f45))
* **questmaster:** support negated quest search ([8f99177](https://github.com/MrVPlusOne/takode/commit/8f99177c436607c09f0dc259fe35a5b858076749))
* **quest:** prevent leader sessions from claiming quests (q-87) ([70dc1f1](https://github.com/MrVPlusOne/takode/commit/70dc1f1f98f3d50e841cfa6fdd01feafa17942e2))
* **search:** add session search category filters ([d9e0d68](https://github.com/MrVPlusOne/takode/commit/d9e0d68e7434d8f809e65d9eba54fa71e7431f02))
* **search:** handle CamelCase splitting in fuzzy search (q-224) ([ad8722a](https://github.com/MrVPlusOne/takode/commit/ad8722a4db1b26c746b4328a036c117ad80ba716))
* **session-names:** use 'Leader N' naming for orchestrator sessions (q-188) ([619f70d](https://github.com/MrVPlusOne/takode/commit/619f70d46ee42dbc1be7f0ff4ee92b38f3461c4a))
* **session:** inject session number into system prompt (q-197) ([44593d3](https://github.com/MrVPlusOne/takode/commit/44593d329748629e603cb5391a59e47b3dbc4ac5))
* **settings:** persist heavy repo mode ([cd88bd2](https://github.com/MrVPlusOne/takode/commit/cd88bd2ee2f2a66c7a88aa1ebd1997ab488b2744))
* **sidebar:** accent border rail + remove collapse footer (q-178) ([569c887](https://github.com/MrVPlusOne/takode/commit/569c88755478964a85acd961b0768b4060bc2e45))
* **sidebar:** add 'Archive Group' option to leader session context menu (q-231) ([797736d](https://github.com/MrVPlusOne/takode/commit/797736d893ad24e71350fb1a47d398c3b77fabd2))
* **sidebar:** add leader-first herd ordering toggle ([91de611](https://github.com/MrVPlusOne/takode/commit/91de611da488782c98f01b487c63d050d5030dda))
* **sidebar:** add sort-by-last-activity toggle (q-124) ([6f6a303](https://github.com/MrVPlusOne/takode/commit/6f6a3039f1548512122184e1ee3b228e5890352d))
* **sidebar:** add tree view mode with herd-centric session grouping ([53dc2c5](https://github.com/MrVPlusOne/takode/commit/53dc2c51cdcb1c014f392edbf6bd5887d7d5d4fa))
* **sidebar:** compact worker chips + leader status summary in tree view ([a383e87](https://github.com/MrVPlusOne/takode/commit/a383e87db8c2ee403f9486410eb6017f8c43b788))
* **sidebar:** Move-to submenu, auto-increment groups, cross-group DnD ([ec23980](https://github.com/MrVPlusOne/takode/commit/ec23980dc6a09ffe32bbbdef514c7e62dd2e26dd))
* **sidebar:** redesign herd tree view with collapsible container (q-173) ([da22462](https://github.com/MrVPlusOne/takode/commit/da224620af3bb7bf5a74720c42a8cee299953189))
* **sidebar:** replace status border bar with dot + VSCode indent guides ([f20bfe5](https://github.com/MrVPlusOne/takode/commit/f20bfe5cbcf43cea0e37f48c06ab79defb526d8a))
* **sidebar:** show reviewer sessions as inline badge on parent row (q-104) ([2feea1d](https://github.com/MrVPlusOne/takode/commit/2feea1d148994028105db723ef6259e80f78b39b))
* **sidebar:** show timer indicator on session chips ([5c97755](https://github.com/MrVPlusOne/takode/commit/5c97755d9bcab5ca005102770cc82ad538bd1ebe))
* **skills:** add random memory ideas skill ([790bd24](https://github.com/MrVPlusOne/takode/commit/790bd247ac54cd8da2c9a1a6b4a49e5b7413cd2f))
* **skills:** split leader-dispatch into dedicated skill with eager loading (q-214) ([6142d85](https://github.com/MrVPlusOne/takode/commit/6142d85f3ba5ff0d35d862ac5e81b586a15a58fb))
* **system-prompt:** add image reading rule to Takode system prompt (q-243) ([1f7b8fd](https://github.com/MrVPlusOne/takode/commit/1f7b8fd11e55f19dd944db9aa7280ce213ab167b))
* **system-prompt:** enforce takode timer over sleep (q-303) ([050afff](https://github.com/MrVPlusOne/takode/commit/050afffa5bbef60f1cf9416ebf7ce623e206bcf3))
* **takode:** add --herd flag to list for explicit herded-only filtering (q-95) ([b3ce262](https://github.com/MrVPlusOne/takode/commit/b3ce26270ee10585aa89d3ff7eec46a2f37fe1ff))
* **takode:** add --show-tools flag to peek for full session audit (q-89) ([7a0b910](https://github.com/MrVPlusOne/takode/commit/7a0b910abc1a9084e523027697fb263fb78e49e7))
* **takode:** add force herd reassignment ([c753342](https://github.com/MrVPlusOne/takode/commit/c753342d73622998971d563aedd8a8f3f055dad4))
* **takode:** add optional summary parameter to notify command (q-131) ([39408cf](https://github.com/MrVPlusOne/takode/commit/39408cf5b18b37d6ff60ec4713ade9598387271c))
* **takode:** improve orchestration visibility ([89f3252](https://github.com/MrVPlusOne/takode/commit/89f32525ffbd61a5345948fc43ea9738e17f9eae))
* **takode:** include message ID in permission_request herd events (q-92) ([6462634](https://github.com/MrVPlusOne/takode/commit/6462634ee27e2b40562e7bf0f9fb31ad68b47fba))
* **takode:** make compaction events visible in scan/peek and searchable (q-247) ([ece5518](https://github.com/MrVPlusOne/takode/commit/ece55187b7d33f133f94c44a6c3c39b7f82c12b0))
* **takode:** optimize scan/peek JSON format for token efficiency (q-287) ([00febc2](https://github.com/MrVPlusOne/takode/commit/00febc20160b7dc7dd19f0bc37826a85923392b9))
* **takode:** require summary text for takode notify (q-304) ([13daba3](https://github.com/MrVPlusOne/takode/commit/13daba33a00ea40ec13c3851659fe37e2cae8b13))
* **takode:** show descriptive pending permission marker in takode list (q-222) ([98ff213](https://github.com/MrVPlusOne/takode/commit/98ff213aef9ed02ac5e99a767fa327b4a0f93ecf))
* **takode:** show pending session timers ([0b48a0f](https://github.com/MrVPlusOne/takode/commit/0b48a0f2fe65c0b7804431dd5913a591b78d5d03))
* **timer:** redesign timer UI as floating chip + modal (q-169) ([ac93e8a](https://github.com/MrVPlusOne/takode/commit/ac93e8a19e6146c2adef5b1563e177a749a1fa91))
* **timers:** add server-side session-scoped timers (q-61) ([e58cff0](https://github.com/MrVPlusOne/takode/commit/e58cff05ae0b8bea8398df3aaac58b654779b2b6))
* **timer:** separate timer titles from descriptions ([0287623](https://github.com/MrVPlusOne/takode/commit/02876231c22b580e5e6e0407084b0d516bd053f9))
* **tool-blocks:** standalone file-tool chips, Open File in header (q-184) ([f2b1652](https://github.com/MrVPlusOne/takode/commit/f2b1652cdacc9f190caa7a982122172504fd0d2a))
* **ui:** add checkbox and reply button to inline notification chips (q-260) ([a287a26](https://github.com/MrVPlusOne/takode/commit/a287a260672c23b73712bf40f9a5879bb5becb0e))
* **ui:** add send button to AskUserQuestion Other input (q-319) ([b843b8b](https://github.com/MrVPlusOne/takode/commit/b843b8b23820365792fe539af921de7b9d689dee))
* **ui:** add status glow to reviewer badge (q-121) ([e5de25f](https://github.com/MrVPlusOne/takode/commit/e5de25f20aa12a352b0a5e560791b404907df189))
* **ui:** auto-collapse plan file writes in ToolBlock (q-314) ([4e0c1d6](https://github.com/MrVPlusOne/takode/commit/4e0c1d6b69353a3b6963fd0bff2f33a2fe63557e))
* **ui:** collapse herd events by default with expandable activity ([8eec20a](https://github.com/MrVPlusOne/takode/commit/8eec20a7ba9172395e73b03ecb0059dce3ae4032))
* **ui:** cross-link quest and session hovers ([a2d0b86](https://github.com/MrVPlusOne/takode/commit/a2d0b866f8aa5398c017a6f5d87abec4b75b8794))
* **ui:** improve session info hover scanning (q-276) ([c62c41e](https://github.com/MrVPlusOne/takode/commit/c62c41e51b19a961e5a3633ab8ab0816a88fe85b))
* **ui:** redesign FolderPicker with breadcrumbs, filter, and keyboard nav (q-315) ([8be1062](https://github.com/MrVPlusOne/takode/commit/8be106297b1ceaf405c4974722ad2d1834b53154))
* **ui:** remove centered minute marks and inline timestamps (q-249) ([0b74095](https://github.com/MrVPlusOne/takode/commit/0b7409550b79f93c508e4abaa162784806b02951))
* **ui:** show message history size in session details popover (q-236) ([16e791c](https://github.com/MrVPlusOne/takode/commit/16e791c566574c7b4dc6a037db01b9ad920ab35b))
* **ui:** show notification chips in collapsed turns (q-277) ([9a00d6e](https://github.com/MrVPlusOne/takode/commit/9a00d6e3c56dbb50fad9d9e8e30e0ed8c3145bd6))
* **ui:** show session message size in hover card (q-291) ([921319c](https://github.com/MrVPlusOne/takode/commit/921319c0fd50ab7db435f093d1c2b57001c604a6))
* **voice:** save recordings on transcription failure and allow retry (q-108) ([9914464](https://github.com/MrVPlusOne/takode/commit/991446491f37952be81837951786c4020cccdcf5))
* **workboard:** order items by status and deps ([22cebb6](https://github.com/MrVPlusOne/takode/commit/22cebb68cb0bf6450fb6b88682bf34d2a641fbd1))
* **workboard:** reorder columns and status labels ([ebc314d](https://github.com/MrVPlusOne/takode/commit/ebc314db3770117d16098f3848f14e68c9d4d72e))
* **workboard:** show original board command ([75f8f65](https://github.com/MrVPlusOne/takode/commit/75f8f65295dd4cc35ce5d1f9b3945843cd7bbd73))
* **ws-bridge:** inject date at date boundaries in CLI user message timestamps (q-103) ([7f56a1e](https://github.com/MrVPlusOne/takode/commit/7f56a1ec48f379a9a41f94f071173da2a10ff12a))


### Bug Fixes

* **app:** suppress false unreachable banner during connected chat ([7e61233](https://github.com/MrVPlusOne/takode/commit/7e61233601ef4e09b788233317f9d9103242ea61))
* **app:** unmount hidden panels while idle ([fb9e983](https://github.com/MrVPlusOne/takode/commit/fb9e9830093290e6bb40e933ebe8d60affa5d2ae))
* **board:** add server-side validation to DELETE/advance routes and log title fetch errors (q-134) ([35efc67](https://github.com/MrVPlusOne/takode/commit/35efc67730101f16c9d87981148fd7c60a9d2a5d))
* **board:** auto-clear waitFor when reassigning quest worker ([b8d387f](https://github.com/MrVPlusOne/takode/commit/b8d387f3ccc671282a56ba4ef9e1caffd5958137))
* **board:** clean up board rows on quest delete and cancel ([f2bb9ac](https://github.com/MrVPlusOne/takode/commit/f2bb9ac50378eda244fa1800e98dcb7fa6aa9ddd))
* **board:** clear resolved wait-for deps ([0369221](https://github.com/MrVPlusOne/takode/commit/0369221f7fd05832100059ba0002625c20430892))
* **board:** decouple board row removal from quest state changes ([c8e8850](https://github.com/MrVPlusOne/takode/commit/c8e88508e8d8b59de48eed36713619eed9af9572))
* **board:** fix clearing wait-for and worker fields via empty strings (q-93) ([d912020](https://github.com/MrVPlusOne/takode/commit/d912020fec83eff3eae0cd15bc8eb3868b0c7a4f))
* **board:** format inline status labels ([edfa23b](https://github.com/MrVPlusOne/takode/commit/edfa23b7c7b24950c11f50f3a549e34386c38958))
* **board:** persist docked board state (q-278) ([877f86f](https://github.com/MrVPlusOne/takode/commit/877f86fc2e15481a05888da02a0bfd34ffe05c75))
* **board:** preserve restored queued dependents ([b8cb593](https://github.com/MrVPlusOne/takode/commit/b8cb59399b7c6e946a49f69d8bac260e5e3d053f))
* **board:** show completed time on completed rows ([0cc4211](https://github.com/MrVPlusOne/takode/commit/0cc4211645e523a4fd3d423b99818c1a4e730a4f))
* **board:** update comment to cover both worker reassign and clear cases ([3017755](https://github.com/MrVPlusOne/takode/commit/30177552b2f90f67a85ab6ba985141dbdbe629e1))
* **board:** validate quest IDs and auto-populate titles (q-134) ([4b97a86](https://github.com/MrVPlusOne/takode/commit/4b97a86aaa718cd71fd9c0d01d2bbc1acde8fb52))
* **bridge:** auto-recover sessions stuck in running state after 5 minutes (q-132) ([c443368](https://github.com/MrVPlusOne/takode/commit/c44336888e8799a7d885fb4701bbb9a2ab85dc99))
* **bridge:** detect silent auto-compaction in SDK sessions via token-drop heuristic (q-149) ([a7561aa](https://github.com/MrVPlusOne/takode/commit/a7561aa2e54be4f4c9a366172e10dcea46ce781f))
* **bridge:** handle status_change for SDK sessions (compaction state tracking) ([dd36ebf](https://github.com/MrVPlusOne/takode/commit/dd36ebfa75f72085959f58e3bc3462da17836f97))
* **bridge:** remove token-drop compaction heuristic (q-151) ([ce25b8a](https://github.com/MrVPlusOne/takode/commit/ce25b8aefac85444961800d1ce7873fbb0d29065))
* **bridge:** synthesize compact_marker from SDK status_change for UI visibility (q-135) ([daf0cab](https://github.com/MrVPlusOne/takode/commit/daf0cabf8f12ebb5f118344bb0a9871405fdb83f))
* **chat:** hide polling actions from trace ([8f067d0](https://github.com/MrVPlusOne/takode/commit/8f067d0fa4782d3990b490270f1d2c886608b123))
* **chat:** keep claude leader herd updates in one turn ([f1e311e](https://github.com/MrVPlusOne/takode/commit/f1e311e1982ce2a4e6631c3d86b0980c2d38ef9d))
* **chat:** keep notification activity in one turn ([2bc3be6](https://github.com/MrVPlusOne/takode/commit/2bc3be6dc7e163497fca19a912eeba5460b46323))
* **chat:** match herd event session links ([42a264b](https://github.com/MrVPlusOne/takode/commit/42a264bc5754d8aba62f1a0a5136c142dc384c9e))
* **chat:** merge Codex continued turns ([8e87475](https://github.com/MrVPlusOne/takode/commit/8e8747553126b6c511fdb9be5474f7f503a71a49))
* **chat:** reset stale subagent state on history sync ([383e15c](https://github.com/MrVPlusOne/takode/commit/383e15c68ee8e41ac5c2ed6ca6d37a1d66f17f86))
* **chat:** show async polling actions ([0756dfe](https://github.com/MrVPlusOne/takode/commit/0756dfe29be9b37d410ab072e209701fd0356660))
* **claude-sdk-adapter:** fix system prompt injection for SDK 0.2.101+ ([32b2628](https://github.com/MrVPlusOne/takode/commit/32b2628eca92cf077aee6beb78e89550746c59c7))
* **cli-launcher:** clean stale .claude/CLAUDE.md worktree guardrails on launch (q-211) ([c9f8acd](https://github.com/MrVPlusOne/takode/commit/c9f8acd6a8f67a9445c8d820ec0c7dd5f0ab4c83))
* **cli:** exclude reviewers from group count + add reviewer nesting tests (q-167) ([11c5b16](https://github.com/MrVPlusOne/takode/commit/11c5b16761cc75f331b1030d03584e1236c1e5d5))
* **cli:** improve herd conflict errors ([05c6dc2](https://github.com/MrVPlusOne/takode/commit/05c6dc2eb6e37e2f182195ce4ad77af9d9a42d8a))
* **codex:** clarify retained payload size and 413 guidance ([f8d56cc](https://github.com/MrVPlusOne/takode/commit/f8d56cce9e68c4cd8e7b6051ce7410b86dda7687))
* **codex:** gate auth recovery per launch ([9c20c7f](https://github.com/MrVPlusOne/takode/commit/9c20c7f501ecb1043e7a2b334981d3990968d027))
* **codex:** handle connector auth startup failures ([1547bb9](https://github.com/MrVPlusOne/takode/commit/1547bb9a3255f321f4407c414a3d328c51780dd5))
* **codex:** harden disconnect recovery and diagnostics ([d5ae690](https://github.com/MrVPlusOne/takode/commit/d5ae690eadabb1294e558922ff4b4acc0167d7a8))
* **codex:** harden image attachment flow ([a71c1a3](https://github.com/MrVPlusOne/takode/commit/a71c1a3efe1b49ebbf8ff6a8f1c604f719c546a4))
* **codex:** harden resume and launcher startup ([2c12c25](https://github.com/MrVPlusOne/takode/commit/2c12c259ded18a75972aae63f4f8ac78c23218f4))
* **codex:** keep session config frozen per session ([cd01e39](https://github.com/MrVPlusOne/takode/commit/cd01e3913cd7b170d0d786a682b6df1ca482f4c6))
* **codex:** move image send status into purring chip ([a9eed85](https://github.com/MrVPlusOne/takode/commit/a9eed859583690889e613febce1c3e52d4ae3b64))
* **codex:** persist leader guardrails ([1934300](https://github.com/MrVPlusOne/takode/commit/1934300d0a9d810869e4e51fe307c408c9c7fe1f))
* **codex:** preserve denied-plan fresh-turn guard ([943498f](https://github.com/MrVPlusOne/takode/commit/943498f3523e76a9b5489a3d683988b4d53aebac))
* **codex:** preserve image send order ([08a1bde](https://github.com/MrVPlusOne/takode/commit/08a1bde8c0e3a728f83dd2576022d96c81b543c5))
* **codex:** preserve queued image follow-ups during active streaming ([c7dc35a](https://github.com/MrVPlusOne/takode/commit/c7dc35af705dcab8c64b60051ea14ae01ccce1c7))
* **codex:** prevent pending cancel delivery mix-up ([268b8dd](https://github.com/MrVPlusOne/takode/commit/268b8ddd8b9e8826ffd799c90e49611c27f22a69))
* **codex:** queue image followups after overlap ([de31e90](https://github.com/MrVPlusOne/takode/commit/de31e90b6d11443959e89a15717730b51ff3c652))
* **codex:** reconcile queued turn completion ([64239f3](https://github.com/MrVPlusOne/takode/commit/64239f3b04ab500f6bfbe60b46ab310f9dd44ec3))
* **codex:** recover pending delivery state ([9d463b4](https://github.com/MrVPlusOne/takode/commit/9d463b4829dfdc51fdbd94fa4840ca509b61a749))
* **codex:** refresh global config on relaunch ([40a21d3](https://github.com/MrVPlusOne/takode/commit/40a21d3f6a98be4422388d5803ce5ba77938dcbc))
* **codex:** restore compact with vscode context ([a508ee2](https://github.com/MrVPlusOne/takode/commit/a508ee231b41f81f7e94596d5cdc16fb764f9081))
* **codex:** restore native localImage transport for image messages (q-322) ([4a2a28b](https://github.com/MrVPlusOne/takode/commit/4a2a28b160b3d102081619cfec98d34fdabbe05d))
* **codex:** restore pending delivery recovery ([a313f8e](https://github.com/MrVPlusOne/takode/commit/a313f8ef7784bc2f534d8f01f6499efd4e84aaba))
* **codex:** show image send stages ([c64c790](https://github.com/MrVPlusOne/takode/commit/c64c790946ed86279ba34a55dc5d7a12daad3276))
* **codex:** surface imageView tool events ([10c3f47](https://github.com/MrVPlusOne/takode/commit/10c3f47d29a6070e014c360e493fec58ae9ee594))
* **codex:** surface raw view_image tool blocks ([7164901](https://github.com/MrVPlusOne/takode/commit/7164901f48f0a01115e5741f5e2dae1683f2100d))
* **codex:** use path-only image transport (q-298) ([bb4512c](https://github.com/MrVPlusOne/takode/commit/bb4512c0c2ee7af47d203b133c37c1d3890a4926))
* **compaction:** prevent duplicate compact markers after revert + /compact (q-227) ([1b5e48e](https://github.com/MrVPlusOne/takode/commit/1b5e48e5d326d6697438f3d8055bba8496c6ef98))
* **composer:** improve editor selection chip ux ([d5ac74d](https://github.com/MrVPlusOne/takode/commit/d5ac74de7266d205435d2a407725036d8b78118a))
* **composer:** keep reply composer expanded on mobile ([a6406dc](https://github.com/MrVPlusOne/takode/commit/a6406dcbb8cedec86c17f024f2158ca1cae95070))
* **composer:** reduce rerenders during session churn ([2f692b1](https://github.com/MrVPlusOne/takode/commit/2f692b122795c4094c8d9b9929b1d9de2b7916d5))
* **debug:** expose claude sdk recording artifacts ([cfce91c](https://github.com/MrVPlusOne/takode/commit/cfce91cb213155eb7d65cf12cb210153d11a61e7))
* **diff-viewer:** render content-only new file edits ([8ff9858](https://github.com/MrVPlusOne/takode/commit/8ff985854b7abf1ed053978dcdbe6f6f9c34de62))
* **diff:** anchor worktree detailed diffs ([6584383](https://github.com/MrVPlusOne/takode/commit/6584383340b91c6a7995518b9a610a1b545b3486))
* **diff:** enable expand between hunks in unified-diff-only mode (q-122) ([adb9e3c](https://github.com/MrVPlusOne/takode/commit/adb9e3cc03c8693bfb4c58585a72368d5a16af55))
* **diff:** prevent diff view from blocking server on large diffs ([85164d8](https://github.com/MrVPlusOne/takode/commit/85164d88fdfc8cc00e312568192de79c1274c247))
* **feed-model:** split delayed herd updates into turns ([5e11960](https://github.com/MrVPlusOne/takode/commit/5e11960cb790890f36e0bf948f375dcb33d0c102))
* **git:** reduce startup fsmonitor churn ([cbf0414](https://github.com/MrVPlusOne/takode/commit/cbf0414329edd5fb194ab4f19897eb5d86185df5))
* **groom:** address skeptic + groom findings for q-237, q-240, q-241 ([d2ddfb9](https://github.com/MrVPlusOne/takode/commit/d2ddfb9cc7f2f44672099b4ab9fe7facefb1ae0e))
* **herd-events:** annotate user archive source ([9a5b5f0](https://github.com/MrVPlusOne/takode/commit/9a5b5f0625d5a6e4a66a197e7a91ec30c77dc0cb))
* **herd-events:** make all herd event chips clickable/expandable ([b492019](https://github.com/MrVPlusOne/takode/commit/b492019d15c30a2b8c7a9549e34df20ae2d85b91))
* **herd-events:** prioritize unseen user messages ([4c81e08](https://github.com/MrVPlusOne/takode/commit/4c81e082c35282b3e58f942ac65011c8cebac664))
* **herd-events:** simplify header tool counts ([b99d30e](https://github.com/MrVPlusOne/takode/commit/b99d30e427b7c33b3f97e7f3f9adebfef5c06a58))
* **herd:** apply key message limit to permission_approved/denied ([9bd757e](https://github.com/MrVPlusOne/takode/commit/9bd757ed79449638b68b5ca7ed6b91da561873a6))
* **herd:** include buildPermissionPreview in SDK permission events (q-215) ([9505dfd](https://github.com/MrVPlusOne/takode/commit/9505dfddb18be85b3b3f39832c7a4cc2c00d1d70))
* **herd:** route all permission events to leader (q-205) ([4f7b5b7](https://github.com/MrVPlusOne/takode/commit/4f7b5b70e618a7ea7b2e5e6f4b490bb89127e200))
* **herd:** use 5000-char key message limit for all event types ([ca6d27a](https://github.com/MrVPlusOne/takode/commit/ca6d27a4e6c5552106f80055c27de0861174acf5))
* **herd:** use 5000-char limit for final assistant message in activity summary ([709df7e](https://github.com/MrVPlusOne/takode/commit/709df7eb5338f6ba63ce9888881ad430ff7fcbd3))
* **history:** narrow assistant snapshot replay dedupe ([1dbe260](https://github.com/MrVPlusOne/takode/commit/1dbe260f89add994a1b1902edb6a89b650407fdd))
* **image:** send attachment paths as text only ([5179622](https://github.com/MrVPlusOne/takode/commit/51796225f6fa293802c7ae7a623382eb4502c778))
* **leader:** add no-echo-CLI-output rule to system prompt and leader ops ([fc4d7b2](https://github.com/MrVPlusOne/takode/commit/fc4d7b248f59e36e3f315c2e7f37edbc62b6d710))
* **leader:** avoid repeating board rows in chat ([2de2098](https://github.com/MrVPlusOne/takode/commit/2de2098c776f1cb5dbcc2098991edd1adf54a9c1))
* **leader:** bake critical behavioral rules into leader system prompt and compaction recovery ([253056b](https://github.com/MrVPlusOne/takode/commit/253056b284515e50365e55cc97a47af4c9b9c815))
* **leader:** clarify queued capacity reasoning ([1715a80](https://github.com/MrVPlusOne/takode/commit/1715a80cae0442bea94aa8295b0bb1925e18e4fb))
* **leader:** clarify reuse vs spawn decisions ([447de98](https://github.com/MrVPlusOne/takode/commit/447de98c22f42a679ce69a4dcbb976abc2e871e9))
* **leader:** narrow no-echo rule to board state only (not all CLI output) ([9b81111](https://github.com/MrVPlusOne/takode/commit/9b81111ffb581392587cf50a2856693ecd563b21))
* **leader:** prevent quest title auto-renames ([65a35c7](https://github.com/MrVPlusOne/takode/commit/65a35c7493a0b7808497d2c68ecaaf8a70cc6fca))
* **leader:** remove deprecated [@to](https://github.com/to) rendering path ([80f635e](https://github.com/MrVPlusOne/takode/commit/80f635e90121f4d12fc7833223ebedf43318e835))
* **links:** show successful result previews ([f675182](https://github.com/MrVPlusOne/takode/commit/f675182705100a7edac8e6c01275e197d5f7f2dc))
* **logging:** fully collapse mobile log filters (q-330) ([936b1bd](https://github.com/MrVPlusOne/takode/commit/936b1bd45becd00eb22c036db047a2cac68f9c5f))
* **logging:** improve mobile log viewer usability (q-330) ([27234d3](https://github.com/MrVPlusOne/takode/commit/27234d376de1c7ef491c912f6e6241cf5b719768))
* **markdown:** continue numbered lists across bullet sublists ([1e0cea7](https://github.com/MrVPlusOne/takode/commit/1e0cea771ba2459882f841865a428dbe70ba9b3c))
* **markdown:** expand wide tables ([412dddc](https://github.com/MrVPlusOne/takode/commit/412dddceae4a65ed6d2c629c0439664b7186783f))
* **markdown:** remap stale worktree file links ([74a276c](https://github.com/MrVPlusOne/takode/commit/74a276cce036c9cfa1b2739c692975fe1cab8d3d))
* **markdown:** respect single newlines in shared renderer ([a6cb7e9](https://github.com/MrVPlusOne/takode/commit/a6cb7e95e101299d64d676e25cd1891088d2773a))
* **message-feed:** avoid mobile nav overlap with status chips ([ab9f6d3](https://github.com/MrVPlusOne/takode/commit/ab9f6d3510b92eea42f8dcd0dc05e0fccd2a8c35))
* **mobile:** enable text selection context menu on iOS/touch devices (q-263) ([095a1f3](https://github.com/MrVPlusOne/takode/commit/095a1f3e5ca70859c7cf5710b0e7d1783366c4d9))
* **notification:** improve quest completion notifications ([c033599](https://github.com/MrVPlusOne/takode/commit/c033599b76c45a7f6e3a364ce7157c941dc761cb))
* **notifications:** compact mobile inbox review rows ([4d9f563](https://github.com/MrVPlusOne/takode/commit/4d9f5639f7420d507a9c786444ee952e08331a1f))
* **notifications:** debounce notification sounds to prevent overlap (q-251) ([5400a2f](https://github.com/MrVPlusOne/takode/commit/5400a2f58a351fac08a5232041ba6a950aa72b6b))
* **notifications:** flatten chip count layout ([7ba7fe1](https://github.com/MrVPlusOne/takode/commit/7ba7fe112c35d3c50f9e3a52b451fd5fa7b35473))
* **notifications:** groom fixes for q-235 ([5bd5ecb](https://github.com/MrVPlusOne/takode/commit/5bd5ecb37d7ffcb91ad050881c32afed4fe9264f))
* **notifications:** groom fixes for q-242 ([5291923](https://github.com/MrVPlusOne/takode/commit/5291923428d14c9e5b6e0a18273a726f116d8431))
* **notifications:** keep menu open while viewing quests ([2d80e6d](https://github.com/MrVPlusOne/takode/commit/2d80e6d57b80d3dd179f4ec00700c5a5f5f3c527))
* **notifications:** popover, navigation, and preview UX (q-242) ([2b47c62](https://github.com/MrVPlusOne/takode/commit/2b47c622fd9cf8bb3d61d0aafa85c2ce51c20e58))
* **notifications:** remove inbox message hover preview ([91ebca6](https://github.com/MrVPlusOne/takode/commit/91ebca6d77ea3e98cf214cda0195ca82b2304894))
* **notifications:** resolve notification deep links for tool-use-only messages (q-274) ([31be7a0](https://github.com/MrVPlusOne/takode/commit/31be7a05e85ff333d951f01d46580d756249b63e))
* **notifications:** show per-type chip counts ([df1ed67](https://github.com/MrVPlusOne/takode/commit/df1ed67c913767ba0d0e58efdcda32124a4e161b))
* **notifications:** suppress browser broadcast for herded session notifications (q-264) ([7266807](https://github.com/MrVPlusOne/takode/commit/7266807e74845927cdb1d1e72afd26c93d39f83b))
* **notifications:** switch sounds to Blue A and Amber A (q-279) ([bf0b89a](https://github.com/MrVPlusOne/takode/commit/bf0b89ab5fe53a0042705d56620c498c5f3e3894))
* **notifications:** update sounds to user-selected Blue B and Amber B (q-256) ([e7e9768](https://github.com/MrVPlusOne/takode/commit/e7e97686208aa3a04e2c91c29030770f34b55c53))
* **notify:** display summary in NotificationMarker and fix Pushover suppression (q-131) ([8a6a66c](https://github.com/MrVPlusOne/takode/commit/8a6a66c2c43323aa41d66ba559e22e12460104f8))
* **notify:** show summary in NotificationMarker and add Pushover debug logs ([4c591f4](https://github.com/MrVPlusOne/takode/commit/4c591f4d331933cca8b2b3e93ab7a5ac465a77b3))
* **orchestration:** add dispatch approval to needs-input notify triggers (q-246) ([2347974](https://github.com/MrVPlusOne/takode/commit/2347974a5ace0460cffa669439baca8af0c6c3b8))
* **orchestration:** add self-scan compaction tip ([6402814](https://github.com/MrVPlusOne/takode/commit/640281424ea23b2ba1b52f2a4613ccd2fcf2a41a))
* **orchestration:** auto review on board completion ([6a49bd8](https://github.com/MrVPlusOne/takode/commit/6a49bd81b4e5c69333d23adb834cb59e1f2b6ae6))
* **orchestration:** fix reviewer cleanup guidance to use archive not interrupt (q-262) ([1fd6138](https://github.com/MrVPlusOne/takode/commit/1fd613891066e1bea8cd1c870a9eb2ca745a33a3))
* **orchestration:** groom fix -- bridge checklist to skeptic review (q-248) ([8d7bf30](https://github.com/MrVPlusOne/takode/commit/8d7bf3051c69fba47677c9c2cffad9b5441f5724))
* **orchestration:** make leader stage guidance explicit (q-272) ([cdcdd4c](https://github.com/MrVPlusOne/takode/commit/cdcdd4ce7627cf32899ba9280e62fba42ddd2e96))
* **orchestration:** narrow needs-input notification trigger (q-288) ([915d87d](https://github.com/MrVPlusOne/takode/commit/915d87d066f4f70a6ab443ed08377333ea1bd525))
* **orchestration:** preserve interrupt source attribution ([6568dd3](https://github.com/MrVPlusOne/takode/commit/6568dd391e643040c3d99a26866e139f51963f6e))
* **orchestration:** re-inject guardrails on session relaunch ([e763d33](https://github.com/MrVPlusOne/takode/commit/e763d33c08138790a320f4489928e13a93848314))
* **orchestration:** require explicit skeptic-review dispatch ([7dd3745](https://github.com/MrVPlusOne/takode/commit/7dd37451bf014b575f90a809faf6ad4476190f51))
* **orchestration:** show leader session numbers to workers ([0fa3a7d](https://github.com/MrVPlusOne/takode/commit/0fa3a7d0cd988ec50af450b775daebedfa8a475e))
* **orchestration:** suppress stale stall warnings ([8e5becf](https://github.com/MrVPlusOne/takode/commit/8e5becfdb84f31d580b74018efa6b255ef1e7427))
* **orchestration:** surface codex stall disconnects ([5e2d865](https://github.com/MrVPlusOne/takode/commit/5e2d8655a76eef2763608aa433b4021f24e8d68d))
* **orchestration:** tighten leader notification guidance ([efc5f68](https://github.com/MrVPlusOne/takode/commit/efc5f6885f5c578bf237700ccee00d6ea2b3016b))
* **orchestration:** transfer attached reviewers with herd changes (q-273) ([f249e32](https://github.com/MrVPlusOne/takode/commit/f249e3214365df1785458b1c392db8eaecd8b2a8))
* **orchestration:** unblock herd-event pending delivery (q-275) ([db13779](https://github.com/MrVPlusOne/takode/commit/db1377998ac27a16cf44323e97bb5e1f67ec482b))
* **orchestration:** warn leaders about worktree archive loss ([165ef84](https://github.com/MrVPlusOne/takode/commit/165ef84f08fce9f157193e0a96f939b8a9f7279a))
* **perf:** reduce unnecessary re-renders from polling and event floods (q-334) ([bdb1818](https://github.com/MrVPlusOne/takode/commit/bdb1818b2c0f942b8905972fe0697bfea95525a8))
* **permissions:** enable Tier 2 settings-rule auto-approval for WS sessions (q-204) ([447b16e](https://github.com/MrVPlusOne/takode/commit/447b16e0dbfab1eb064d6121f8a87ce490e4ffb4))
* **playground:** add tool result image lightbox mock to Playground ([4d913eb](https://github.com/MrVPlusOne/takode/commit/4d913eba1313aa85ff489b6d98206f8048fcedb6))
* **pushover:** remove noisy 'not configured' log and add skipReadCheck test ([c6daf34](https://github.com/MrVPlusOne/takode/commit/c6daf34c2a4ad649ffc32ef32135f1ac9660170c))
* **quest-link:** show read-only modal overlay instead of navigating to Questmaster (q-102) ([613d321](https://github.com/MrVPlusOne/takode/commit/613d3217054cbabc7675bfb00b83a76e2bd18c0b))
* **quest-modal:** make verification checkboxes interactive (q-171) ([9cc1a50](https://github.com/MrVPlusOne/takode/commit/9cc1a50ed066462270811c3e6960d9c49048ff2e))
* **questmaster:** clarify negated tag search syntax ([54fe602](https://github.com/MrVPlusOne/takode/commit/54fe602c153349439a0c1f82875c4580cad8ad93))
* **questmaster:** copy quest ids from quest views ([d04eddc](https://github.com/MrVPlusOne/takode/commit/d04eddc3f7715c8e4506f2ec3130481b81512b56))
* **questmaster:** flatten compact quest table ([07c79e4](https://github.com/MrVPlusOne/takode/commit/07c79e4e286292f4f4ac86e191c7227db3c41fcc))
* **questmaster:** harden feedback edit updates ([ad55048](https://github.com/MrVPlusOne/takode/commit/ad55048251dd1b892df4dad6f01499d728d05c3a))
* **questmaster:** keep quest comment composer visible ([99a6cfa](https://github.com/MrVPlusOne/takode/commit/99a6cfa3c35f9b14e117d2ef582ec14234c4e80c))
* **questmaster:** open quest images in lightbox ([d255c6f](https://github.com/MrVPlusOne/takode/commit/d255c6f39353829f82cda527603c21a672e8bc5c))
* **questmaster:** reduce idle refresh churn ([e23a782](https://github.com/MrVPlusOne/takode/commit/e23a7825b934bd5127d13863a74a807194f279a3))
* **questmaster:** style journey status labels ([a2f0b0d](https://github.com/MrVPlusOne/takode/commit/a2f0b0dcd7b78216ebd0e93cd422588aae0352e7))
* **quest:** refine grep output contract ([2a0c378](https://github.com/MrVPlusOne/takode/commit/2a0c3784fb734cc147345d9ec63e83db28fd4d25))
* **quest:** serialize parallel creation ([e1370e1](https://github.com/MrVPlusOne/takode/commit/e1370e1d44b511e31cca193a9d043fb6534d3b55))
* **quest:** show session numbers in quest detail ([1174f4b](https://github.com/MrVPlusOne/takode/commit/1174f4b2c1dbe335d9a96d6f7f4b6fdedbd93729))
* **quest:** streamline no-code handoffs ([678c26d](https://github.com/MrVPlusOne/takode/commit/678c26de3c6ca247507f7def57dac1120506351e))
* remove --coverage from pre-commit hook and fix 7 pre-existing test failures ([5c7f7b0](https://github.com/MrVPlusOne/takode/commit/5c7f7b0e0926ecf0e87d84377ea258c73f518a0c))
* **revert:** clear eventBuffer and clamp frozenCount on history revert (q-225) ([73750da](https://github.com/MrVPlusOne/takode/commit/73750da65b060411b6321a353f1f184494d3410f))
* **sdk:** intercept /compact in Claude SDK adapter ([0d7ee4a](https://github.com/MrVPlusOne/takode/commit/0d7ee4ae3f2f3f5e7f4e770c609d4603770a6152))
* **selection-menu:** document-level mouseup + remove flicker on click ([ee8f487](https://github.com/MrVPlusOne/takode/commit/ee8f487cf1c48c784a3b655d18ed602a22b34b52))
* **selection-menu:** fix regression + reposition to not block selection (q-174) ([21c2288](https://github.com/MrVPlusOne/takode/commit/21c2288f2fc6a884c30cd1e2b04edcd0bb68b234))
* **selection-menu:** only show context menu after mouseup, not mid-drag ([202c878](https://github.com/MrVPlusOne/takode/commit/202c87875d3868c1201a9f566f46b82d052f6bb5))
* **session-item:** replace nested button with div role=button for reviewer badge ([1102591](https://github.com/MrVPlusOne/takode/commit/1102591b15e22221b1053bfa07ad33a9617fc3dd))
* **session-namer:** handle model responses with preamble before code fence ([8ed199c](https://github.com/MrVPlusOne/takode/commit/8ed199c940cd63c59b97d83e96f6e80390e50f0c))
* **session-state:** persist diff base branch across restart (q-318) ([6d987d9](https://github.com/MrVPlusOne/takode/commit/6d987d9ae1096ad574211be9d5752d49b9b4b770))
* **session:** archive worktree branches as lightweight refs for unarchive (q-329) ([adbc8eb](https://github.com/MrVPlusOne/takode/commit/adbc8eb24519b22696f44ad9b0973f9de79ae157))
* **session:** don't set context_used_percent from compact_boundary pre_tokens (q-250) ([a0e0405](https://github.com/MrVPlusOne/takode/commit/a0e04058b9946b84d48548cb3fd4306f0f8d9013))
* **session:** preserve worktree branch across archive/unarchive (q-329) ([8439aff](https://github.com/MrVPlusOne/takode/commit/8439afff611aeaa4a8ed06f4779a00217d304d64))
* **session:** remove pre_tokens context update from SDK adapter paths (q-250) ([d6f39c9](https://github.com/MrVPlusOne/takode/commit/d6f39c9f1d7623d67bf0629a7107840b52dcf063))
* **sessions:** avoid blocking git worktree setup ([b185a77](https://github.com/MrVPlusOne/takode/commit/b185a7758b39526ef926dd27506f4588c4ef34eb))
* **settings:** gate sleep inhibitor live status ([a501ed2](https://github.com/MrVPlusOne/takode/commit/a501ed2137d15c1df5b40e91ef7fb6f85f9a994e))
* **settings:** remove stray q-470 conflict marker ([820f0f0](https://github.com/MrVPlusOne/takode/commit/820f0f020bfd8fb7b2fdc3460e682c582ca30869))
* **sidebar:** align glow opacity + remove dead indentLevel opts ([e121890](https://github.com/MrVPlusOne/takode/commit/e1218907fab79e859861917442653a531c58de39))
* **sidebar:** align timer status icon ([b74af81](https://github.com/MrVPlusOne/takode/commit/b74af81db73948193cdbfb17cc254c09dd90316f))
* **sidebar:** confirm leader archive with active herd ([1f14df1](https://github.com/MrVPlusOne/takode/commit/1f14df1882783a0dca2a133bdc8d23f2fa13afb7))
* **sidebar:** disable drag-and-drop in activity sort mode ([5a8f544](https://github.com/MrVPlusOne/takode/commit/5a8f5448cf2ab6ea385ab78f9a7e4efd26a61768))
* **sidebar:** disable herd hover highlight in tree view mode (q-206) ([7b63c22](https://github.com/MrVPlusOne/takode/commit/7b63c2253d1d6eee326aa28626b0bc9d17d414b9))
* **sidebar:** hydrate tree groups on mount to fix post-restart grouping ([1e62488](https://github.com/MrVPlusOne/takode/commit/1e62488200f1aff79b01a99d1c79a52bd7a34c79))
* **sidebar:** keep herd leaders inside project groups ([07ceb05](https://github.com/MrVPlusOne/takode/commit/07ceb05875fe0c477c11f874d9362794484df727))
* **sidebar:** nest reviewer sessions under parent worker's project group (q-98) ([b34e916](https://github.com/MrVPlusOne/takode/commit/b34e916fecbef7880d20eeacd269e0bc3ded44f5))
* **sidebar:** new session + button assigns to correct tree group (q-179) ([be46ea0](https://github.com/MrVPlusOne/takode/commit/be46ea0f564a5f4e26ffb072eba6e578e370a32f))
* **sidebar:** preview reviewer chip correctly ([95d307c](https://github.com/MrVPlusOne/takode/commit/95d307c99772f703d608209faeb5907cd1a00850))
* **sidebar:** remove legacy linear session view ([8888962](https://github.com/MrVPlusOne/takode/commit/8888962e96ab1f572dad9fcba8c50730b95f826b))
* **sidebar:** show timer icon for idle sessions ([00a43bf](https://github.com/MrVPlusOne/takode/commit/00a43bf510475e25d9ae7b0ed5d6a71f3cb02869))
* **sidebar:** sort sessions by last user message time, not assistant activity ([a4f94ef](https://github.com/MrVPlusOne/takode/commit/a4f94ef3fab77fdf4d94085066abd1a84e5164d1))
* **sidebar:** stabilize quest checkbox titles ([a60e481](https://github.com/MrVPlusOne/takode/commit/a60e481990e8cec604b6498db325f23d048e8e1b))
* **sidebar:** sync idle timer icon state ([941cbc6](https://github.com/MrVPlusOne/takode/commit/941cbc66bbe753f63d57af5974d4edaa9e8e9a0f))
* **sidebar:** tree view + linear view UI regressions (q-165) ([0c2df1e](https://github.com/MrVPlusOne/takode/commit/0c2df1e240e99c6b7ea6b721c84846bfa593a98a))
* **sidebar:** tree view indent guide, empty groups, reviewer chips (q-165 rework) ([ffd672a](https://github.com/MrVPlusOne/takode/commit/ffd672a7b83565a1b0ee1c4cf83750c7ad21c94a))
* **sidebar:** tree view UX round 3 -- groups, indent, leader badge (q-165) ([36295ad](https://github.com/MrVPlusOne/takode/commit/36295ad4a00dc5f97da23b3e196b732878eb4da4))
* **sidebar:** use checkbox prefix instead of yellow text for quest titles ([0fb80cd](https://github.com/MrVPlusOne/takode/commit/0fb80cdaa4cb65335342d75a9e7687854470f98e))
* **skill-symlink:** resolve relative git-common-dir path to absolute ([5fb46e8](https://github.com/MrVPlusOne/takode/commit/5fb46e83d2543fbd8cbe6cb1635e6e872dde0e6e))
* **skill:** rewrite skeptic-review for reviewer perspective only (q-106) ([f317194](https://github.com/MrVPlusOne/takode/commit/f3171945b99b8aa05cd95494ddf2bfd0f61f7cbb))
* **skills:** clarify /port-changes mapping (q-269) ([eaa9fb8](https://github.com/MrVPlusOne/takode/commit/eaa9fb8bfcaeff24dbfd1c768e725ed21ef9aa47))
* **skills:** rework reviewer-groom workflow ([b9d4ed7](https://github.com/MrVPlusOne/takode/commit/b9d4ed75b1e76ce29e017e4dd406e73bd71d42cc))
* **skills:** sync project skill symlinks for agents ([6133a05](https://github.com/MrVPlusOne/takode/commit/6133a058247908255193ef8865f27d6df814a770))
* **skills:** update stale file references in leader prompt lifecycle (q-218) ([0229c35](https://github.com/MrVPlusOne/takode/commit/0229c359f89bf630bd8e78bd3f190e46e1c5ccaf))
* **takode-orchestration:** enforce dispatch-workflow.md and fix dispatch defaults (q-101) ([0623df6](https://github.com/MrVPlusOne/takode/commit/0623df63409635fcb43cc21c2874aa3ddb8f8d6c))
* **takode:** address skeptic review findings for JSON format optimization (q-287) ([e107aab](https://github.com/MrVPlusOne/takode/commit/e107aab8e4e2294f91a1a8451b2d2e7754fd5b76))
* **takode:** clarify worker-slot herd limit ([71df1ba](https://github.com/MrVPlusOne/takode/commit/71df1ba747d93e7f67e2c4c7bd4316042060c5e7))
* **takode:** improve cli help routing ([9915686](https://github.com/MrVPlusOne/takode/commit/9915686b799cb34a2af03794ca792daa3ee6ead9))
* **takode:** improve compaction recovery prompts ([d6fb0ce](https://github.com/MrVPlusOne/takode/commit/d6fb0ce4f1a3823bbad54f1fc4bbbddf5fd99190))
* **takode:** improve peek/scan/read output formatting (q-203) ([2c8b55c](https://github.com/MrVPlusOne/takode/commit/2c8b55c284798ee943c050952ae835ea108d1d8d))
* **takode:** improve queued wait-for detection ([9e35e50](https://github.com/MrVPlusOne/takode/commit/9e35e50bc8e1cb8a0140561a7832f2568e3c425e))
* **takode:** make skeptic review mandatory, groom review conditional (q-91) ([53c6f3d](https://github.com/MrVPlusOne/takode/commit/53c6f3d92122d269dd13e8ac8f358b862730c048))
* **takode:** read attached images before responding ([0e27847](https://github.com/MrVPlusOne/takode/commit/0e2784710a7ba8e22826080bc06982cc9bd8420d))
* **takode:** reject archived reviewer sends ([72d7748](https://github.com/MrVPlusOne/takode/commit/72d77488ad332c8b47c8934d15830ed42a4930e1))
* **takode:** simplify board output and scan probe ([84646eb](https://github.com/MrVPlusOne/takode/commit/84646eb0e4ed3b25196a3784af3edf18a523bb33))
* **takode:** tighten clarification answer flow ([360e31d](https://github.com/MrVPlusOne/takode/commit/360e31d1160d3ff4aaf4e49074b2f5156e8899ab))
* **takode:** use turn-local assistant summaries ([1767be5](https://github.com/MrVPlusOne/takode/commit/1767be5f1bb65eb44c42e1bfa8d97c109bab702c))
* **takode:** warn when grep pattern contains \| BRE alternation (q-229) ([aafdfac](https://github.com/MrVPlusOne/takode/commit/aafdfac0acaa0bf888da5aafc5e7d40679057b30))
* **task-panel:** keep diagnostics section visible ([f0c6890](https://github.com/MrVPlusOne/takode/commit/f0c6890e77e7f896b42fd7f1c6e8330c4f7196be))
* **test:** add touchUserMessage mock to ws-bridge test launchers ([32b35a3](https://github.com/MrVPlusOne/takode/commit/32b35a3be6c07614a81bc0198ccb900137287f69))
* **test:** align q-431 disconnect fixture ([3d11a49](https://github.com/MrVPlusOne/takode/commit/3d11a49eee30d1b985396cb65142ec0fdc6b57d7))
* **timer:** cancel notification, ID reuse, and countdown format (q-169) ([6c00904](https://github.com/MrVPlusOne/takode/commit/6c00904bfa73238279ee2c8ec50063f9be604128))
* **timer:** keep timer chip compact ([0e99843](https://github.com/MrVPlusOne/takode/commit/0e998439b85cb9355ada5fa314d3d74c909551db))
* **timer:** move chip to lower-right, side-by-side with Purring (q-169) ([421f69a](https://github.com/MrVPlusOne/takode/commit/421f69aa86e7f742acb0fe3bdae6e0253d28123b))
* **timer:** separate chip positions — Purring lower-left, timer lower-right (q-169) ([d4a6049](https://github.com/MrVPlusOne/takode/commit/d4a604911af075cc5880b781a17c37f3a83b7299))
* **timer:** show single unified countdown for delay timers ([11cc4e1](https://github.com/MrVPlusOne/takode/commit/11cc4e117e8f04e302c44b03ee51f7a171d6cdcd))
* **timers:** move useMemo before early return to fix conditional hook crash ([777465f](https://github.com/MrVPlusOne/takode/commit/777465f5dcb3df749dfde9f170462f1126238d45))
* **timers:** repurpose scheduled page for active timers ([041e8d3](https://github.com/MrVPlusOne/takode/commit/041e8d37d0da6bfc28829234aeb87003d004040d))
* **timer:** tighten chip countdown formatting ([d969452](https://github.com/MrVPlusOne/takode/commit/d969452222c4fce8518e74597ee0b6253da1af4b))
* **todo:** show new lists immediately ([9f50217](https://github.com/MrVPlusOne/takode/commit/9f502170a7bddeb3f3eefe0a4d8d106ee2d53fe1))
* **tool-block:** make tool result image previews clickable with lightbox modal (q-199) ([dcb43e0](https://github.com/MrVPlusOne/takode/commit/dcb43e007ad1ab580cf46d999ec254ab3c795b67))
* **tool-block:** restore view image helpers ([315fb79](https://github.com/MrVPlusOne/takode/commit/315fb79899eb701b62e7aea1e777ffa0c9672a80))
* **toolblock:** prevent React [#185](https://github.com/MrVPlusOne/takode/issues/185) re-render crash on Bash tool expansion (q-170) ([a1fd7ae](https://github.com/MrVPlusOne/takode/commit/a1fd7ae21777fbf5069efe503f41a5f7121f0fa8))
* **transcription:** ack phase before stt completes ([1424d8f](https://github.com/MrVPlusOne/takode/commit/1424d8f33105bf77c93651ddeafeae7906aed466))
* **transcription:** expose upload stage before stt ([f70c7b5](https://github.com/MrVPlusOne/takode/commit/f70c7b53e0c1b620185493f52c86059b1698cb47))
* **tree-view:** extend accent bar over full herd container and add session borders ([12482b3](https://github.com/MrVPlusOne/takode/commit/12482b3b93448661e3f9317e6f54cb37c40f118f))
* **tree-view:** move herd summary status dots to right side of bar ([f425ab8](https://github.com/MrVPlusOne/takode/commit/f425ab88e91f4c62e4f9da9365f30bb9f4c7a87a))
* **tree-view:** render reviewer sessions as inline chips, not separate nodes ([220ebc9](https://github.com/MrVPlusOne/takode/commit/220ebc94d9073495a0899231bf2e58899d56e29b))
* **tree-view:** show reviewer sessions in herd expansion (q-185) ([45ca5f8](https://github.com/MrVPlusOne/takode/commit/45ca5f8ff7af934ee65d553d8eb13e65f9523fae))
* **types:** restore clean jiayi typecheck ([9dd2f96](https://github.com/MrVPlusOne/takode/commit/9dd2f96f8059833892a8dbd62157c7ea8e511417))
* **ui:** add review chip checkbox affordance (q-302) ([17488c0](https://github.com/MrVPlusOne/takode/commit/17488c0efdecc35ac198cba0e2ecd4e2a89f4f5c))
* **ui:** address groom findings for renderHeaderActions stability ([b5d40b8](https://github.com/MrVPlusOne/takode/commit/b5d40b8d85669143cf10f2a5acb23fd70b30dcce))
* **ui:** address groom review feedback for ToolBlock error boundary ([4711dbc](https://github.com/MrVPlusOne/takode/commit/4711dbc67874de611a65f3fa2c7d17e542576b8c))
* **ui:** auto-fit context menu width to content ([fe88950](https://github.com/MrVPlusOne/takode/commit/fe88950a0c0df3ed5f76696495c3baf4248e966b))
* **ui:** avoid false notify chips ([4f181ae](https://github.com/MrVPlusOne/takode/commit/4f181aeee946eb47c632b25aeaa353349f094726))
* **ui:** deduplicate notification chips and restyle with subtle theme (q-187) ([de66d48](https://github.com/MrVPlusOne/takode/commit/de66d487b717671daf4efbc577d43e90894724f8))
* **ui:** expose Codex revert action safely (q-289) ([62d4378](https://github.com/MrVPlusOne/takode/commit/62d4378dbd11d4a1277efbec2c36c0aabb143db0))
* **ui:** fix intermittent sound notification failures (q-257) ([53830ca](https://github.com/MrVPlusOne/takode/commit/53830ca5d64d0e4860ceb89853f38360b316a333))
* **ui:** fix notification message links, hover preview, and panel close (q-254) ([08483d0](https://github.com/MrVPlusOne/takode/commit/08483d02b1d0d769436513feec026bdfea6dbe72))
* **ui:** guard session hover quest lookup ([71f501b](https://github.com/MrVPlusOne/takode/commit/71f501be38c38126ef52ff97a8cc0d8dc98b08e9))
* **ui:** hide herd event summary lines in collapsed turn view ([7d03ded](https://github.com/MrVPlusOne/takode/commit/7d03dedc6fe70d4e36dc9f1b3c3c9d9aa8e318e1))
* **ui:** limit herd event chip width to prevent horizontal scroll (q-226) ([513b953](https://github.com/MrVPlusOne/takode/commit/513b95308cee97f194b00b8d6aaa527aae841b8b))
* **ui:** narrow Composer store selectors to prevent streaming lag (q-265) ([104a997](https://github.com/MrVPlusOne/takode/commit/104a997e2a30079362bf23165319077fdd54352d))
* **ui:** notification chip replaces terminal block and preview uses markdown (q-258) ([c533de2](https://github.com/MrVPlusOne/takode/commit/c533de2bd1f73990af1fc1a3babeaee3aaa0136b))
* **ui:** overhaul herd event display with chip UI and correct parsing (q-183) ([a453862](https://github.com/MrVPlusOne/takode/commit/a453862cd198ced3ab53606097db6b6b4a11cb82))
* **ui:** preserve blank lines in herd event activity for 1:1 fidelity ([bd45808](https://github.com/MrVPlusOne/takode/commit/bd4580809e8f59bab8c8c863517f8f94a8ceedb5))
* **ui:** prevent horizontal scrolling in chat feed (q-313) ([735c882](https://github.com/MrVPlusOne/takode/commit/735c882867dce1043948662bdb6326214802173b))
* **ui:** prevent stale quest chips on browser reconnect (q-255) ([10efeff](https://github.com/MrVPlusOne/takode/commit/10efeff57bb69aa775cfc498775bc0da35c48b6b))
* **ui:** prevent ToolBlock re-render storms causing React error [#185](https://github.com/MrVPlusOne/takode/issues/185) ([f1aa279](https://github.com/MrVPlusOne/takode/commit/f1aa27989076a4c37e7152b7b94f662093cc5404))
* **ui:** put notification and timer chips on the same line (q-309) ([38ea03a](https://github.com/MrVPlusOne/takode/commit/38ea03a66b01a4f8d3217d717dc757688213b15e))
* **ui:** remember session-group creation defaults ([bef9e3f](https://github.com/MrVPlusOne/takode/commit/bef9e3ffe4e9e975d9337b5cebf693d264d57ec9))
* **ui:** remove centered minute markers from collapsed turn view (q-172) ([ade4f35](https://github.com/MrVPlusOne/takode/commit/ade4f35bb47774f6e09c1db76300707335cc19a5))
* **ui:** render message-link hovers like chat ([02729a8](https://github.com/MrVPlusOne/takode/commit/02729a847af63c3537318f516c6a9df87b9778be))
* **ui:** stabilize EditToolDetail renderHeaderActions to prevent infinite re-render loop ([e9a5534](https://github.com/MrVPlusOne/takode/commit/e9a55341e57e6c5ded78213165d0c845a4a3d4a5))
* **ui:** use bell icon for both notification categories and restore cross-session markers (q-260) ([28b4987](https://github.com/MrVPlusOne/takode/commit/28b498724bdea3e61a66bb4115c475f004985ab7))
* **voice:** eliminate lost initial words via mic stream pre-warming ([0da4c9b](https://github.com/MrVPlusOne/takode/commit/0da4c9b4a0688c9245194af33d2da1d45b26659e))
* **voice:** extend mobile transcription timeout ([bf03447](https://github.com/MrVPlusOne/takode/commit/bf03447d797aedbb7a8bd5f75419c61f849d1659))
* **voice:** keep mobile composer open while recording ([48a1153](https://github.com/MrVPlusOne/takode/commit/48a1153f3ee8152ef743db2dc30b6ab198728bde))
* **voice:** tighten Shift prewarm gesture (q-282) ([071fd3d](https://github.com/MrVPlusOne/takode/commit/071fd3d2a2b33abed0f692518a4098e46f2fa03d))
* **workboard:** persist docked board open state ([8093253](https://github.com/MrVPlusOne/takode/commit/80932538f3730cbf5ab52ad248969984ffe660e0))
* **workflow:** harden feedback rework cycle ([7a71bb0](https://github.com/MrVPlusOne/takode/commit/7a71bb01e368895f086db6289f43a8433048a221))
* **workflow:** strengthen reviewer-groom guidance ([29396a0](https://github.com/MrVPlusOne/takode/commit/29396a0dc0f13d01dea2ef77cbe6a0fbf17be05d))
* **workflow:** tighten reviewer-groom guardrails ([7599888](https://github.com/MrVPlusOne/takode/commit/759988830de1eccd455b093bf82fdb174f90868b))
* **worktree:** preserve tracked claude settings files ([b1fc2b2](https://github.com/MrVPlusOne/takode/commit/b1fc2b2880db49c4fcde43228831437c57048453))
* **ws-bridge:** auto-compact SDK sessions on relaunch when context is near-full (q-181) ([cf7e67b](https://github.com/MrVPlusOne/takode/commit/cf7e67bd7119d3a330fcca8a503c6f95257f6f4e))
* **ws-bridge:** auto-compact SDK sessions on relaunch when context is near-full (q-181) ([aa77010](https://github.com/MrVPlusOne/takode/commit/aa77010054a5436ad036ce8c9bb431cc0570d7f9))
* **ws-bridge:** clear non-ahead worktree diff totals ([9cbbf83](https://github.com/MrVPlusOne/takode/commit/9cbbf83f468a0ef412058dcf6ce2d414788a80cc))
* **ws-bridge:** clear stale Claude queued turn state ([113c76a](https://github.com/MrVPlusOne/takode/commit/113c76a401d450f344c653fbbc6ef10284b3c37b))
* **ws-bridge:** clear stale toolStartTimes that suppress stuck detection (q-237) ([cc10589](https://github.com/MrVPlusOne/takode/commit/cc1058938e0c15f951db3bf137ddfe6f11087218))
* **ws-bridge:** defer queued message flush until --resume replay completes (q-209) ([2aac63c](https://github.com/MrVPlusOne/takode/commit/2aac63c8021cd693dcc4c5cdd1bcd88ae8398222))
* **ws-bridge:** drop stale board_stalled codex deliveries ([12b4a7a](https://github.com/MrVPlusOne/takode/commit/12b4a7ae88c3f52f6b1a8e73cfd5afc03b6e23bf))
* **ws-bridge:** exclude keep_alive pings from stuck detection activity check (q-237) ([35f1273](https://github.com/MrVPlusOne/takode/commit/35f1273bdfe7c23ad72c8e4967a23c397df981a8))
* **ws-bridge:** fall back to full history sync on frozen hash mismatch (q-212) ([c133fe7](https://github.com/MrVPlusOne/takode/commit/c133fe76990b0413aa85622aac8a30d5d1c56c0d))
* **ws-bridge:** fix context usage double-counting when cache tokens are a subset of input_tokens ([0b7fc6e](https://github.com/MrVPlusOne/takode/commit/0b7fc6e31518b22327783396522c136d2c3edef4))
* **ws-bridge:** forward CLI slash commands without timestamp tagging ([69544c8](https://github.com/MrVPlusOne/takode/commit/69544c833c304fbc9f58213d7fb733cd2558820e))
* **ws-bridge:** groom fixes for q-223 -- em-dash and null-safety ([6de38e3](https://github.com/MrVPlusOne/takode/commit/6de38e3ebbdd1e45a443887e4c89c8d90a28f588))
* **ws-bridge:** guard SDK sessions from stale status_change during resume replay (q-220) ([dd91b2a](https://github.com/MrVPlusOne/takode/commit/dd91b2ae4aa030a5f50b86a9aa3ea404c7a9fe0f))
* **ws-bridge:** guard status_change broadcast during --resume replay (q-213) ([3809b9b](https://github.com/MrVPlusOne/takode/commit/3809b9bbd42d7a3fee98c25a9c5bc54f7eaaebed))
* **ws-bridge:** inject system prompt via initialize control_request for WebSocket sessions ([32b04d7](https://github.com/MrVPlusOne/takode/commit/32b04d77f94d0cf3463d2957470e2a70765a100e))
* **ws-bridge:** intercept /compact before timestamp tagging for all backend types ([0bd4c79](https://github.com/MrVPlusOne/takode/commit/0bd4c79e04b8a5e73a651fee883344bb4e66e349))
* **ws-bridge:** preserve codex queued herd recovery ([32dac0e](https://github.com/MrVPlusOne/takode/commit/32dac0ec1c29a95e180b65f40ae7f174f6be13cc))
* **ws-bridge:** preserve compaction recovery prompts after force compact ([4b27a75](https://github.com/MrVPlusOne/takode/commit/4b27a753a7f9455dd80b8560bc46ac5e7a58a47c))
* **ws-bridge:** preserve permissionMode across SDK session_init (q-316) ([0c19efc](https://github.com/MrVPlusOne/takode/commit/0c19efc2ae9bb654c6f1019f8a7bf800271fc3fd))
* **ws-bridge:** preserve quest lifecycle naming order ([8178709](https://github.com/MrVPlusOne/takode/commit/8178709d36ab69ca55d2723d287e546136edb419))
* **ws-bridge:** restore jiayi regressions ([6778169](https://github.com/MrVPlusOne/takode/commit/6778169cd0f0c90b7f76842d540d15f318096181))
* **ws-bridge:** robust stuck session detection and recovery (q-307) ([1f0fa11](https://github.com/MrVPlusOne/takode/commit/1f0fa1185fcaf77e37fa3f83d1f69cdad85621d3))
* **ws-bridge:** send file path annotations instead of inline base64 for all backends (q-223) ([7049cbc](https://github.com/MrVPlusOne/takode/commit/7049cbc0be710018633e6ec05e47df4e55ed2adb))
* **ws-bridge:** skip cumulative result usage for context % calculation (q-208) ([b35b286](https://github.com/MrVPlusOne/takode/commit/b35b2862b9c337c9d8e3e1b938f10e035abb877c))
* **ws-bridge:** suppress false Claude compaction recovery ([ec94c9d](https://github.com/MrVPlusOne/takode/commit/ec94c9d224877258ac6d54469e770aa054ed0373))
* **ws-bridge:** suppress replayed compaction recovery (q-317) ([ac0ded4](https://github.com/MrVPlusOne/takode/commit/ac0ded4ace7ab598deb883aa48bee530d10f3156))
* **ws-bridge:** suppress spurious error side-effects on WS interrupt (q-202) ([8d73644](https://github.com/MrVPlusOne/takode/commit/8d73644cd39dee36deed411d93b7801f7b1cb7fd))
* **ws-bridge:** suppress spurious restart interruptions ([b22911d](https://github.com/MrVPlusOne/takode/commit/b22911dfb88b1469f723327c8ff0af699c30c76f))
* **ws-bridge:** unblock stuck Codex message delivery after server restart (q-385) ([fd1e44b](https://github.com/MrVPlusOne/takode/commit/fd1e44bba659c9e139553aa8b5402535cac1ede5))
* **ws:** avoid duplicate codex relaunch on injected prompts ([c69ba2d](https://github.com/MrVPlusOne/takode/commit/c69ba2d21d108af38132ffa96d9e98bff833b541))
* **ws:** clear pending Codex inputs on authoritative history sync ([8494e59](https://github.com/MrVPlusOne/takode/commit/8494e595d4b604544400dcfef9dfdedef9766762))
* **ws:** recover mobile reconnect sockets ([738a0b4](https://github.com/MrVPlusOne/takode/commit/738a0b443c646e591d3783260c7590a55f75c3fb))
* **ws:** recover replay-deferred herd wakeups ([93c6ada](https://github.com/MrVPlusOne/takode/commit/93c6ada3dd69c7343acd014c5dc07a607f4853ec))
* **ws:** type orchestrator session init ([7779ed2](https://github.com/MrVPlusOne/takode/commit/7779ed25f067a9215a7cad3ce6c3e5508148fc2e))


### Performance Improvements

* **sidebar:** skip unchanged poll hydration ([913d9ee](https://github.com/MrVPlusOne/takode/commit/913d9eed3ab7a7611f8b0d7f0f77452cc4214307))
* **ui:** narrow shell store subscriptions ([c633b04](https://github.com/MrVPlusOne/takode/commit/c633b04e980294954bf570bc7e0d691370a47089))
* **ws-bridge:** fix event loop blocking in sendHistorySync (q-125) ([d67ba33](https://github.com/MrVPlusOne/takode/commit/d67ba339f214221be02adbcb772eaa7d41a7589c))


### Reverts

* remove redundant rules from compaction recovery prompt (initial prompt suffices) ([06a9d3c](https://github.com/MrVPlusOne/takode/commit/06a9d3c8a9365c1c8404f4f55aa30bfa3c113488))

## 2026-04-12

### Added

- **Notification inbox** -- Per-session notification inbox collects `takode notify` events into a persistent, browsable popover with message links, hover previews, and done/active sections (q-235, q-242)
- **Work board completed history** -- Board items now move to a collapsible "Completed" section instead of being deleted, preserving work history (q-238)
- **Archive Group** -- One-click context menu action to archive an entire orchestration group (leader + workers + reviewers) (q-231)
- **Message history size** -- Session details popover now shows message history size in MB/KB for visibility into API limit proximity (q-236)
- **Compaction events in scan/peek** -- Compaction markers now appear in `takode scan`/`peek` output and are indexed for session search (q-247)
- **Pre-submission checklist** -- Workers must now address all human feedback, add a summary comment, and only include human-verification items before submitting quests (q-248)
- **Leader notification trigger rules** -- Explicit guidance on when to use `takode notify` for needs-input and review-ready events (q-246)
- **Quest journey enforcement** -- Leader guardrails now prohibit skipping review/groom stages regardless of change size (q-241)
- **Leader "wait for user answer" rule** -- Leaders persist the rule to wait for user answers across compaction (q-240)
- **Leader "no blocking tools" rule** -- Leaders are prevented from using AskUserQuestion/EnterPlanMode which would stall herd event processing (q-234)

### Fixed

- **Stale context usage after compaction** -- Context usage percentage no longer shows a stale pre-compaction value; removed incorrect `pre_tokens` context update from all three compact_boundary handlers (q-250)
- **Stuck reviewer sessions** -- Fixed reviewer sessions showing as "generating" indefinitely after completing their skeptic review (q-237)
- **Duplicate compaction markers** -- Fixed /compact after revert producing two separate compaction markers with different summaries (q-227)
- **Grep BRE warning** -- `takode grep` now warns when `\|` BRE alternation syntax returns zero results, suggesting JS/ERE `|` instead (q-229)

### Changed

- **Cleaner chat timestamps** -- Removed centered minute marks and moved generation duration inline with message text (q-249)
- **Unified quest detail modal** -- Replaced lightweight in-chat quest modal with the full Questmaster detail view everywhere (q-239)
- **Image compression on ingest** -- PNG screenshots are now converted to JPEG q85 when stored, reducing image size by ~22% with no visible quality loss (q-232)
- **Improved herd event formatting** -- Cleaner turn_end summaries with quoted content, separate tool lines, and restored permission icons (q-245)
- **Image reading rule** -- Sessions now try reading images directly first and only resize on failure (q-243)

## 2026-04-11

### Added

- **Session-message deep links** -- Deep-link to specific messages within sessions with auto-expand of collapsed containers and scroll-to-reveal with amber highlight (q-201)
- **User message Markdown** -- User messages now render with a conservative Markdown subset (code fences, bold/italic, lists, links) instead of plain text (q-216)
- **CamelCase fuzzy search** -- Searching "plan mode" now matches "ExitPlanMode" by splitting CamelCase tokens across all search surfaces (q-224)
- **Leader-dispatch dedicated skill** -- Extracted leader dispatch workflow into a dedicated skill so critical dispatch rules survive compaction (q-214)
- **Plan content in herd events** -- ExitPlanMode herd events now include the full plan text so leaders can review plans inline (q-215)
- **Session number in system prompt** -- Sessions receive their Takode session number for self-referencing during orchestration (q-197)
- **Session info after herding** -- `takode herd` now prints full session metadata after herding (q-192)
- **Pending permission markers** -- `takode list --herd` shows a visible indicator next to sessions with unresolved permission requests (q-222)
- **Board --wait-for session numbers** -- Work board's `--wait-for` flag now accepts `#N` session numbers in addition to `q-N` quest IDs (q-219)

### Fixed

- **Unified image handling** -- Both WS and SDK backends now send user images as file path annotations instead of inline base64, reducing API request size (q-223)
- **Session stalls after restart** -- Fixed SDK and WebSocket sessions stalling after server restart due to generation lifecycle tracking issues (q-220)
- **History sync on reconnect** -- Fixed browser receiving no history on WebSocket reconnect by falling back to full history delivery on frozen hash mismatch (q-212)
- **Stale running state after relaunch** -- Fixed UI showing 'running' state after a WS session turn completes on relaunch (q-213)
- **Permission routing to leader** -- Fixed permission requests from herded WebSocket sessions not being delivered as herd events to the leader (q-205)
- **WS auto-approval in ask=off mode** -- Fixed WebSocket sessions not auto-approving permission requests in `ask=off` mode (q-204)
- **Stale worktree guardrails** -- Fixed stale `.claude/CLAUDE.md` worktree guardrails conflicting with dynamic system prompt injection (q-211)
- **Context usage double-counting** -- Fixed incorrect context usage percentage for WS and Codex sessions by consolidating cache-detection logic (q-208)
- **Reverted messages reappearing** -- Prevented stale reverted messages from resurfacing after server restart (q-225)
- **WS interrupt error suppression** -- Fixed spurious error side-effects during WebSocket session interruption (q-202)
- **Herd event chip overflow** -- Constrained herd event chip width to prevent horizontal scroll (q-226)
- **Clickable tool result images** -- Tool result image previews now open in a lightbox modal (q-199)
- **Diff expand between hunks** -- Enabled expand buttons to reveal collapsed code between diff hunks in unified-diff view (q-122)
- **Peek/scan output formatting** -- Improved readability with tool call prefixes and multi-line continuation symbols (q-203)
- **Queued message flush on resume** -- Deferred queued message flush until --resume replay completes (q-209)
- **Leader prompt lifecycle** -- Fixed stale file references after leader-dispatch skill split (q-218)
- **Selection menu regression** -- Fixed text selection context menu and repositioned to not block selected text (q-174)

## 2026-04-10

### Added

- **Leader session naming** -- Leader sessions are now auto-named "Leader N" with a persistent counter instead of the autonamer (q-188)
- **Standalone file-tool chips** -- Edit/Write/Read tool calls now render as standalone chips with smart-truncated file paths and always-visible Open File button (q-184)
- **Random memory ideas skill** -- New skill for capturing random ideas, notes, and references to Notion

### Fixed

- **System prompt injection for SDK 0.2.101+** -- Fixed system prompt injection for new Agent SDK versions via initialize control_request (both SDK and WebSocket paths)
- **Reviewer sessions in tree view** -- Fixed reviewer sessions not appearing in sidebar tree view herd expansion (q-185)
- **Duplicate notification chips** -- Fixed `takode notify` showing two notification chips instead of one (q-187)
- **Text selection menu** -- Fixed regression and repositioned selection context menu (q-174)
- **Tree view styling** -- Extended accent bar over full herd container, moved status dots to right side, rendered reviewer sessions as inline chips (q-185)

### Changed

- **Agent SDK bump** -- Upgraded `@anthropic-ai/claude-agent-sdk` from 0.2.63 to 0.2.101
- **Removed cron-scheduling skill** -- Replaced by the Takode timer mechanism
- **Collapsed turn timestamps** -- Removed centered minute markers from collapsed turn view for cleaner layout (q-172)

## [0.46.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.45.0...the-companion-v0.46.0) (2026-02-16)


### Features

* **containers:** add Codex CLI support in Docker sessions ([#290](https://github.com/The-Vibe-Company/companion/issues/290)) ([992604b](https://github.com/The-Vibe-Company/companion/commit/992604b229542de87cacd8547c7d74955b05c5d8))


### Bug Fixes

* **sidebar:** separate scheduled runs from regular sessions ([#284](https://github.com/The-Vibe-Company/companion/issues/284)) ([cc0f042](https://github.com/The-Vibe-Company/companion/commit/cc0f042472363e40410728c550a7e6e2275ab80b))

## [0.45.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.44.1...the-companion-v0.45.0) (2026-02-16)


### Features

* **containers:** implement workspace isolation and git auth seeding in Docker sessions ([d651cc3](https://github.com/The-Vibe-Company/companion/commit/d651cc3144f65c939bdcb91f7f6900951a161552))
* **routing:** add session ID to URL hash for deep-linking ([#289](https://github.com/The-Vibe-Company/companion/issues/289)) ([ddd15ac](https://github.com/The-Vibe-Company/companion/commit/ddd15ac194390eb7b7bf4d7ff0850d71b2ff498a))
* **ui:** add full-screen session launch overlay ([#287](https://github.com/The-Vibe-Company/companion/issues/287)) ([0f31196](https://github.com/The-Vibe-Company/companion/commit/0f3119629de91271a0f3d92da2124f5028fe543b))


### Bug Fixes

* **ui:** cap textarea height and add overflow scroll for long prompts ([#285](https://github.com/The-Vibe-Company/companion/issues/285)) ([2b26bc7](https://github.com/The-Vibe-Company/companion/commit/2b26bc7b4122d22d29c821d9e1db29cce7dfbc64))

## [0.44.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.44.0...the-companion-v0.44.1) (2026-02-16)


### Bug Fixes

* **containers:** switch Docker registry from ghcr.io to Docker Hub ([525687e](https://github.com/The-Vibe-Company/companion/commit/525687e3e6d4eae3ab1125599c62881ee0ce80ac))

## [0.44.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.43.0...the-companion-v0.44.0) (2026-02-16)


### Features

* **containers:** pull Docker images from ghcr.io + session creation progress UI ([#281](https://github.com/The-Vibe-Company/companion/issues/281)) ([e87cfae](https://github.com/The-Vibe-Company/companion/commit/e87cfaed99010c37e12eca5adcaa30e8e5c07cb6))
* **containers:** replace git worktree isolation with Docker container-based sessions ([#277](https://github.com/The-Vibe-Company/companion/issues/277)) ([92a6172](https://github.com/The-Vibe-Company/companion/commit/92a6172db4bfa4bef613f21fa1bc243c848f7b9d))
* **containers:** seed git auth (gitconfig + gh token) in Docker sessions ([198be0e](https://github.com/The-Vibe-Company/companion/commit/198be0ef7465e3d355e34945fa67151e0457f096))


### Bug Fixes

* **ci:** only tag Docker image as :latest on version tags ([63ca679](https://github.com/The-Vibe-Company/companion/commit/63ca67934ab6d4a9024f5aa6031b4e059baeca79))
* **containers:** rewrite SSH git remotes to HTTPS inside containers ([6c867e3](https://github.com/The-Vibe-Company/companion/commit/6c867e36cc7b76a94c59e646ba37813b4aea651b))

## [0.43.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.42.0...the-companion-v0.43.0) (2026-02-15)


### Features

* **assistant:** add Companion — persistent AI assistant session ([#268](https://github.com/The-Vibe-Company/companion/issues/268)) ([ec0e90b](https://github.com/The-Vibe-Company/companion/commit/ec0e90b8b58f0ec09104590b182941a4d7c9b503))

## [0.42.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.41.0...the-companion-v0.42.0) (2026-02-15)


### Features

* **cron:** add scheduled task system for autonomous sessions ([#84](https://github.com/The-Vibe-Company/companion/issues/84)) ([e02c55a](https://github.com/The-Vibe-Company/companion/commit/e02c55a079bb0f81b71bc7a1fd44b23181d97bb1))

## [0.41.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.40.1...the-companion-v0.41.0) (2026-02-15)


### Features

* **server:** add always-on session recorder with line-based rotation ([#262](https://github.com/The-Vibe-Company/companion/issues/262)) ([369df07](https://github.com/The-Vibe-Company/companion/commit/369df07642f74f7abb523ed0323912f4f6b3d989))
* **ui:** enhanced tool rendering, tool_progress, and Codex session details ([#264](https://github.com/The-Vibe-Company/companion/issues/264)) ([a12963c](https://github.com/The-Vibe-Company/companion/commit/a12963cd014643fdd6785b03ad9e57016c1f7219))


### Bug Fixes

* **ui:** address review comments - stray 0 render, concurrent progress clearing ([#265](https://github.com/The-Vibe-Company/companion/issues/265)) ([6dfdee0](https://github.com/The-Vibe-Company/companion/commit/6dfdee0dbd25bc896e2c3ef37727021130da1808))

## [0.40.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.40.0...the-companion-v0.40.1) (2026-02-15)


### Reverts

* **plugins:** remove event-driven plugin runtime ([#260](https://github.com/The-Vibe-Company/companion/issues/260)) ([ea8011a](https://github.com/The-Vibe-Company/companion/commit/ea8011a714b9bdac096eb7bce8a6eca9b71e0eb1))

## [0.40.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.39.1...the-companion-v0.40.0) (2026-02-14)


### Features

* **plugins:** add event-driven plugin runtime with frontend integration ([#251](https://github.com/The-Vibe-Company/companion/issues/251)) ([fdc7418](https://github.com/The-Vibe-Company/companion/commit/fdc7418b7e0a0e17e31e0dbeaf45a7c0fad810cc))


### Bug Fixes

* **repo:** add tailored greptile code review rules ([#258](https://github.com/The-Vibe-Company/companion/issues/258)) ([2030e55](https://github.com/The-Vibe-Company/companion/commit/2030e553015800b757716393ada8fe2b1527f5bf))

## [0.39.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.39.0...the-companion-v0.39.1) (2026-02-14)


### Bug Fixes

* **ui:** keep session action controls visible on mobile ([#247](https://github.com/The-Vibe-Company/companion/issues/247)) ([209ac9a](https://github.com/The-Vibe-Company/companion/commit/209ac9a3f2d5bd99e3e2dbe46dc9eb7b10e40082))

## [0.39.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.38.0...the-companion-v0.39.0) (2026-02-14)


### Features

* **telemetry:** add posthog analytics, opt-out controls, and CI env wiring ([#238](https://github.com/The-Vibe-Company/companion/issues/238)) ([743aeab](https://github.com/The-Vibe-Company/companion/commit/743aeab86aa5b9141c86f605bbd3572694c80113))

## [0.38.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.37.2...the-companion-v0.38.0) (2026-02-13)


### Features

* **settings:** add application update controls to settings ([#234](https://github.com/The-Vibe-Company/companion/issues/234)) ([17760af](https://github.com/The-Vibe-Company/companion/commit/17760afb3cade5e325b7771cabbe0f78034512e5))


### Bug Fixes

* **landing:** focus messaging on codex, mcp, terminal and secure remote setup ([#237](https://github.com/The-Vibe-Company/companion/issues/237)) ([80759a7](https://github.com/The-Vibe-Company/companion/commit/80759a7ed3209d8aebf1e108d3e0c68d7bb8824f))

## [0.37.2](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.37.1...the-companion-v0.37.2) (2026-02-13)


### Bug Fixes

* **ws:** add durable replay cursors and idempotent message handling ([#232](https://github.com/The-Vibe-Company/companion/issues/232)) ([fba76e7](https://github.com/The-Vibe-Company/companion/commit/fba76e730ea5398a2df9dbda2167c32f49c7668f))

## [0.37.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.37.0...the-companion-v0.37.1) (2026-02-13)


### Bug Fixes

* **settings:** correct auto-renaming helper copy ([#230](https://github.com/The-Vibe-Company/companion/issues/230)) ([5da1586](https://github.com/The-Vibe-Company/companion/commit/5da15865508e6ae5bbcda45e149f64bc966b141c))

## [0.37.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.36.2...the-companion-v0.37.0) (2026-02-13)


### Features

* **ui:** show session name in top bar ([#228](https://github.com/The-Vibe-Company/companion/issues/228)) ([a9dc926](https://github.com/The-Vibe-Company/companion/commit/a9dc926d761c2dbbef741a2e7b05ecba29bd29b8))


### Bug Fixes

* **web:** compare file diffs against default branch ([#226](https://github.com/The-Vibe-Company/companion/issues/226)) ([b437d2c](https://github.com/The-Vibe-Company/companion/commit/b437d2c5705ee32cb4e7964dd1d33113d3470f9d))

## [0.36.2](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.36.1...the-companion-v0.36.2) (2026-02-13)


### Bug Fixes

* **cli-launcher:** bypass shebang to use correct Node for Codex ([#223](https://github.com/The-Vibe-Company/companion/issues/223)) ([9fe1583](https://github.com/The-Vibe-Company/companion/commit/9fe158358880789ec80ea5bd5daf738a261089dc))
* **ui:** move terminal, settings, and environments to full pages ([#224](https://github.com/The-Vibe-Company/companion/issues/224)) ([be1de35](https://github.com/The-Vibe-Company/companion/commit/be1de35e816ac782d4ba5c948f0b00abf0641f75))

## [0.36.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.36.0...the-companion-v0.36.1) (2026-02-13)


### Bug Fixes

* **cli-launcher:** pass enriched PATH to spawned CLI/Codex processes ([#221](https://github.com/The-Vibe-Company/companion/issues/221)) ([661e8b4](https://github.com/The-Vibe-Company/companion/commit/661e8b45d9909b9e59b0ecb396a4fb7a143f2816))

## [0.36.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.35.0...the-companion-v0.36.0) (2026-02-13)


### Features

* add Linux systemd support for service install/uninstall ([#169](https://github.com/The-Vibe-Company/companion/issues/169)) ([73fb3f7](https://github.com/The-Vibe-Company/companion/commit/73fb3f721efde79fec50f9c74a4f078f821c35d3))
* add MCP server management support ([#198](https://github.com/The-Vibe-Company/companion/issues/198)) ([018cf1f](https://github.com/The-Vibe-Company/companion/commit/018cf1f65ea5e281c19a39367f8cccf14ac56c1f))
* Add permission & plan approval E2E tests ([#6](https://github.com/The-Vibe-Company/companion/issues/6)) ([8590a68](https://github.com/The-Vibe-Company/companion/commit/8590a68657f0a06e94795a179ad4bbedae782c63))
* add release-please for automated npm publishing ([#24](https://github.com/The-Vibe-Company/companion/issues/24)) ([93b24ee](https://github.com/The-Vibe-Company/companion/commit/93b24ee4a12b3f32e81f59a348b25e89aaa86dce))
* allow dev server access over Tailscale/LAN ([#33](https://github.com/The-Vibe-Company/companion/issues/33)) ([9599d7a](https://github.com/The-Vibe-Company/companion/commit/9599d7ad4e2823d51c8fa262e1dcd96eeb056244))
* claude.md update ([7fa4e7a](https://github.com/The-Vibe-Company/companion/commit/7fa4e7adfdc7c409cfeed4e8a11f237ff0572234))
* **cli:** add service install/uninstall and separate dev/prod ports ([#155](https://github.com/The-Vibe-Company/companion/issues/155)) ([a4e5ba6](https://github.com/The-Vibe-Company/companion/commit/a4e5ba6ced2cc8041f61b303b0205f36e50b7594))
* **cli:** add stop and restart service commands ([#185](https://github.com/The-Vibe-Company/companion/issues/185)) ([04da8e5](https://github.com/The-Vibe-Company/companion/commit/04da8e5a3d3f0e363f662cdd6bca6145eaec479f))
* **cli:** start and stop Companion via daemon service ([#201](https://github.com/The-Vibe-Company/companion/issues/201)) ([39e2b79](https://github.com/The-Vibe-Company/companion/commit/39e2b79a6dbb70e7c7dcaf3ccbaf2116ac26b43a))
* **codex:** add offline protocol compatibility guardrails and playground coverage ([#194](https://github.com/The-Vibe-Company/companion/issues/194)) ([bf0a43e](https://github.com/The-Vibe-Company/companion/commit/bf0a43e5fdc791166e76391c0ee1ad3cf18dae10))
* Corriger menu dossier mobile et décalage clavier ([#151](https://github.com/The-Vibe-Company/companion/issues/151)) ([8068925](https://github.com/The-Vibe-Company/companion/commit/8068925f6a5ec5c6b7a40b36398bd4f9be04708d))
* e2e permissions plans ([#9](https://github.com/The-Vibe-Company/companion/issues/9)) ([53b38bf](https://github.com/The-Vibe-Company/companion/commit/53b38bfd4e773454492a3fea10e8db7ffd3fd768))
* Fix Diffs panel for worktree/relative paths and untracked files ([#165](https://github.com/The-Vibe-Company/companion/issues/165)) ([6810643](https://github.com/The-Vibe-Company/companion/commit/681064328d2bf3f4fc5c3a1867abc1536d2d54f3))
* Hide successful no-output command results ([#139](https://github.com/The-Vibe-Company/companion/issues/139)) ([a66e386](https://github.com/The-Vibe-Company/companion/commit/a66e386491e6887c5684cd70f63cc49cac0a64b7))
* **landing:** add marketing landing page for thecompanion.sh ([#128](https://github.com/The-Vibe-Company/companion/issues/128)) ([170b89c](https://github.com/The-Vibe-Company/companion/commit/170b89c72012dfb0ba68239a7665634d65275aa3))
* OpenRouter-based session auto-naming + settings page ([#168](https://github.com/The-Vibe-Company/companion/issues/168)) ([a86b1e7](https://github.com/The-Vibe-Company/companion/commit/a86b1e711ff1c38985bb3d622c6ec372a266637e))
* protocol conformance fixes and improved E2E tests ([#14](https://github.com/The-Vibe-Company/companion/issues/14)) ([51b13b9](https://github.com/The-Vibe-Company/companion/commit/51b13b9d647de6c92881b1abb61161f39152e0ef))
* Redesign README as a landing page with API-first documentation ([#7](https://github.com/The-Vibe-Company/companion/issues/7)) ([a59e1b4](https://github.com/The-Vibe-Company/companion/commit/a59e1b4604baf87faa32af7d62e4846afae49dbe))
* **sidebar:** group sound and alerts under notification ([#203](https://github.com/The-Vibe-Company/companion/issues/203)) ([0077e75](https://github.com/The-Vibe-Company/companion/commit/0077e75208e7505a53db8a829a9480a77b8c3916))
* simplified claude() API, unified endpoints, and landing page README ([#12](https://github.com/The-Vibe-Company/companion/issues/12)) ([aa2e535](https://github.com/The-Vibe-Company/companion/commit/aa2e535fe0a83b726ff2a2c08359e55973a9136b))
* The Vibe Companion complete web UI rewrite + npm package ([#23](https://github.com/The-Vibe-Company/companion/issues/23)) ([0bdc77a](https://github.com/The-Vibe-Company/companion/commit/0bdc77a81b21cd9d08ba29ea48844e73df3a1852))
* trigger release for statusline capture ([#19](https://github.com/The-Vibe-Company/companion/issues/19)) ([cedc9df](https://github.com/The-Vibe-Company/companion/commit/cedc9dfb7445344bdb43a1a756f1d2e538e08c76))
* **web:** adaptive server-side PR polling with WebSocket push ([#178](https://github.com/The-Vibe-Company/companion/issues/178)) ([57939e4](https://github.com/The-Vibe-Company/companion/commit/57939e4030a4b0e5a7dae39d93c34944e3bdff0f))
* **web:** add browser web notifications ([#191](https://github.com/The-Vibe-Company/companion/issues/191)) ([092c59a](https://github.com/The-Vibe-Company/companion/commit/092c59aff620aa2b2eac51903c01ad7cb0c4bc8e))
* **web:** add CLAUDE.md editor button in TopBar ([#170](https://github.com/The-Vibe-Company/companion/issues/170)) ([f553b9b](https://github.com/The-Vibe-Company/companion/commit/f553b9b86842f0b47c0bf24b08903e0352b7b078))
* **web:** add Clawd-inspired pixel art logo and favicon ([#70](https://github.com/The-Vibe-Company/companion/issues/70)) ([b3994ef](https://github.com/The-Vibe-Company/companion/commit/b3994eff2eac62c3cf8f40a8c31b720c910a7601))
* **web:** add component playground and ExitPlanMode display ([#36](https://github.com/The-Vibe-Company/companion/issues/36)) ([e958be7](https://github.com/The-Vibe-Company/companion/commit/e958be780f1b6e1a8f65daedbf968cdf6ef47798))
* **web:** add embedded code editor with file tree, changed files tracking, and diff view ([#81](https://github.com/The-Vibe-Company/companion/issues/81)) ([3ed0957](https://github.com/The-Vibe-Company/companion/commit/3ed095790c73edeef911ab4c73d74f1998100c5c))
* **web:** add embedded terminal in sidebar ([#175](https://github.com/The-Vibe-Company/companion/issues/175)) ([e711c5d](https://github.com/The-Vibe-Company/companion/commit/e711c5d5ef40edfa9c265642383a4c526b9b3ece))
* **web:** add git worktree support for isolated multi-branch sessions ([#64](https://github.com/The-Vibe-Company/companion/issues/64)) ([fee39d6](https://github.com/The-Vibe-Company/companion/commit/fee39d62986cd99700ba78c84a1f586331955ff8))
* **web:** add GitHub PR status to TaskPanel sidebar ([#166](https://github.com/The-Vibe-Company/companion/issues/166)) ([6ace3b2](https://github.com/The-Vibe-Company/companion/commit/6ace3b2944ec9e9082a11a45fe0798f0f5f41e55))
* **web:** add missing message-flow components to Playground ([#156](https://github.com/The-Vibe-Company/companion/issues/156)) ([ef6c27d](https://github.com/The-Vibe-Company/companion/commit/ef6c27dfa950c11b09394c74c4452c0b02aed8fb))
* **web:** add notification sound on task completion ([#99](https://github.com/The-Vibe-Company/companion/issues/99)) ([337c735](https://github.com/The-Vibe-Company/companion/commit/337c735e8267f076ada4b9ef01632d37376ec2d0))
* **web:** add OpenAI Codex CLI backend integration ([#100](https://github.com/The-Vibe-Company/companion/issues/100)) ([54e3c1a](https://github.com/The-Vibe-Company/companion/commit/54e3c1a2b359719d7983fa9ee857507e1446f505))
* **web:** add per-session usage limits with OAuth refresh and Codex support ([24ebd32](https://github.com/The-Vibe-Company/companion/commit/24ebd32f5ec617290b6b93e8bc76972a3b80d6a9))
* **web:** add permission suggestions and pending permission indicators ([10422c1](https://github.com/The-Vibe-Company/companion/commit/10422c1464b6ad4bc45eb90e6cd9ebbc0ebeac92))
* **web:** add PWA support for mobile home screen install ([#116](https://github.com/The-Vibe-Company/companion/issues/116)) ([85e605f](https://github.com/The-Vibe-Company/companion/commit/85e605fd758ee952e0d5b1dbc6f7065b514844a7))
* **web:** add update-available banner with auto-update for service mode ([#158](https://github.com/The-Vibe-Company/companion/issues/158)) ([727bd7f](https://github.com/The-Vibe-Company/companion/commit/727bd7fbd16557fd63ce41632592c1485e69713c))
* **web:** add usage limits display in session panel ([#97](https://github.com/The-Vibe-Company/companion/issues/97)) ([d29f489](https://github.com/The-Vibe-Company/companion/commit/d29f489ed9951d36ff45ec240410ffd8ffdf05eb))
* **web:** archive sessions instead of deleting them ([#56](https://github.com/The-Vibe-Company/companion/issues/56)) ([489d608](https://github.com/The-Vibe-Company/companion/commit/489d6087fc99b9131386547edaf3bd303a114090))
* **web:** enlarge homepage logo as hero element ([#71](https://github.com/The-Vibe-Company/companion/issues/71)) ([18ead74](https://github.com/The-Vibe-Company/companion/commit/18ead7436d3ebbe9d766754ddb17aa504c63703f))
* **web:** git fetch on branch picker open ([#72](https://github.com/The-Vibe-Company/companion/issues/72)) ([f110405](https://github.com/The-Vibe-Company/companion/commit/f110405edbd0f00454edd65ed72197daf0293182))
* **web:** git info display, folder dropdown fix, dev workflow ([#43](https://github.com/The-Vibe-Company/companion/issues/43)) ([1fe2069](https://github.com/The-Vibe-Company/companion/commit/1fe2069a7db17b410e383f883c934ee1662c2171))
* **web:** git worktree support with branch picker and git pull ([#65](https://github.com/The-Vibe-Company/companion/issues/65)) ([4d0c9c8](https://github.com/The-Vibe-Company/companion/commit/4d0c9c83f4fe13be863313d6c945ce0b671a7f8a))
* **web:** group sidebar sessions by project directory ([#117](https://github.com/The-Vibe-Company/companion/issues/117)) ([deceb59](https://github.com/The-Vibe-Company/companion/commit/deceb599975f53141e9c0bd6c7675437f96978b8))
* **web:** named environment profiles (~/.companion/envs/) ([#50](https://github.com/The-Vibe-Company/companion/issues/50)) ([eaa1a49](https://github.com/The-Vibe-Company/companion/commit/eaa1a497f3be61f2f71f9467e93fa2b65be19095))
* **web:** persist sessions to disk for dev mode resilience ([#45](https://github.com/The-Vibe-Company/companion/issues/45)) ([c943d00](https://github.com/The-Vibe-Company/companion/commit/c943d0047b728854f059e26facde950e08cdfe0c))
* **web:** redesign session list with avatars, auto-reconnect, and git info ([#111](https://github.com/The-Vibe-Company/companion/issues/111)) ([8a7284b](https://github.com/The-Vibe-Company/companion/commit/8a7284b3c08dc301a879924aea133945697b037a))
* **web:** replace CodeMirror editor with unified diff viewer ([#160](https://github.com/The-Vibe-Company/companion/issues/160)) ([f9b6869](https://github.com/The-Vibe-Company/companion/commit/f9b686902011ffd194a118cc1cb022bac71eaa3b))
* **web:** replace folder picker dropdown with fixed-size modal ([#76](https://github.com/The-Vibe-Company/companion/issues/76)) ([979e395](https://github.com/The-Vibe-Company/companion/commit/979e395b530cdb21e6a073ba60e33ea8ac497e2a))
* **web:** session rename persistence + auto-generated titles ([#79](https://github.com/The-Vibe-Company/companion/issues/79)) ([e1dc58c](https://github.com/The-Vibe-Company/companion/commit/e1dc58ce8ab9a619d36f2261cce89b90cfdb70d6))
* **web:** warn when branch is behind remote before session creation ([#127](https://github.com/The-Vibe-Company/companion/issues/127)) ([ef89d5c](https://github.com/The-Vibe-Company/companion/commit/ef89d5c208ca5da006aaa88b78dbd647186fb0df))


### Bug Fixes

* add web/dist to gitignore ([#2](https://github.com/The-Vibe-Company/companion/issues/2)) ([b9ac264](https://github.com/The-Vibe-Company/companion/commit/b9ac264fbb99415517636517e8f503d40fe3253d))
* always update statusLine settings on agent spawn ([#21](https://github.com/The-Vibe-Company/companion/issues/21)) ([71c343c](https://github.com/The-Vibe-Company/companion/commit/71c343cfd29fff3204ad0cc2986ff000d1be5adc))
* auto-accept workspace trust prompt and handle idle in ask() ([#16](https://github.com/The-Vibe-Company/companion/issues/16)) ([ded31b4](https://github.com/The-Vibe-Company/companion/commit/ded31b4cf9900f7ed8c3ff373ef16ae8f1e8a886))
* checkout selected branch when worktree mode is off ([#68](https://github.com/The-Vibe-Company/companion/issues/68)) ([500f3b1](https://github.com/The-Vibe-Company/companion/commit/500f3b112c5ccc646c7965344b5774efe1338377))
* **cli:** auto-update restarts service reliably via explicit systemctl/launchctl ([#208](https://github.com/The-Vibe-Company/companion/issues/208)) ([33fa67e](https://github.com/The-Vibe-Company/companion/commit/33fa67ebd75609b9a7b8700ce67b1dd949663b06))
* **cli:** expose stop/restart in help and add test ([#188](https://github.com/The-Vibe-Company/companion/issues/188)) ([c307525](https://github.com/The-Vibe-Company/companion/commit/c30752545f2137fd7c03525d5bb7f5f8851271d4))
* **cli:** fix Linux systemd service management (start, auto-restart) ([#213](https://github.com/The-Vibe-Company/companion/issues/213)) ([fc1dd65](https://github.com/The-Vibe-Company/companion/commit/fc1dd65a9fd32958d47499af1b35992a0c10fe8e))
* **cli:** refresh systemd unit file on start/restart to prevent restart loops ([#215](https://github.com/The-Vibe-Company/companion/issues/215)) ([35f80d9](https://github.com/The-Vibe-Company/companion/commit/35f80d963b1f0f0feccf7215a9bd4711b4520a12))
* **cli:** resolve binaries via user shell PATH when running as service ([#216](https://github.com/The-Vibe-Company/companion/issues/216)) ([47e4967](https://github.com/The-Vibe-Company/companion/commit/47e4967215a5bfd84c8afc2a86ce42151c73d187))
* **codex:** fix 3 critical bugs in Codex backend integration ([#147](https://github.com/The-Vibe-Company/companion/issues/147)) ([0ec92db](https://github.com/The-Vibe-Company/companion/commit/0ec92db909c7be42f94cc21d2890c9c123702dd7))
* **codex:** handle init failure gracefully and isolate per-session CODEX_HOME ([#210](https://github.com/The-Vibe-Company/companion/issues/210)) ([f4efcea](https://github.com/The-Vibe-Company/companion/commit/f4efceace6c260de92df728335678b7bded3e144))
* make service stop actually stop on macOS and refresh stale update checks ([#192](https://github.com/The-Vibe-Company/companion/issues/192)) ([f608f64](https://github.com/The-Vibe-Company/companion/commit/f608f64887bf78b2cca909aa20bd87e4a897ce94))
* remove vibe alias, update repo URLs to companion ([#30](https://github.com/The-Vibe-Company/companion/issues/30)) ([4f7b47c](https://github.com/The-Vibe-Company/companion/commit/4f7b47cba86c278e89fe81292fea9b8b3e75c035))
* scope permission requests to their session tab ([#35](https://github.com/The-Vibe-Company/companion/issues/35)) ([ef9f41c](https://github.com/The-Vibe-Company/companion/commit/ef9f41c8589e382de1db719984931bc4e91aeb11))
* show pasted images in chat history ([#32](https://github.com/The-Vibe-Company/companion/issues/32)) ([46365be](https://github.com/The-Vibe-Company/companion/commit/46365be45ae8b325100ed296617455c105d4d52e))
* **sidebar:** nest notification toggles behind disclosure ([#207](https://github.com/The-Vibe-Company/companion/issues/207)) ([87e71b8](https://github.com/The-Vibe-Company/companion/commit/87e71b8f5bf3e47c96421bca315ac412934a7dc2))
* **task-panel:** enable scrolling for long MCP sections ([#204](https://github.com/The-Vibe-Company/companion/issues/204)) ([b98abbb](https://github.com/The-Vibe-Company/companion/commit/b98abbbea4355c7e91d4dc322e53e638f4e4c542))
* track all commits in release-please, not just web/ ([#27](https://github.com/The-Vibe-Company/companion/issues/27)) ([d49f649](https://github.com/The-Vibe-Company/companion/commit/d49f64996d02807baf0482ce3c3607ae59f78638))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([e296ab0](https://github.com/The-Vibe-Company/companion/commit/e296ab0fabd6345b1f21c7094ca1f8d6f6af79cb))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([#26](https://github.com/The-Vibe-Company/companion/issues/26)) ([61eed5a](https://github.com/The-Vibe-Company/companion/commit/61eed5addd6e332fac360d9ae8239f1b0f93868e))
* use random suffixes for worktree branch names ([#88](https://github.com/The-Vibe-Company/companion/issues/88)) ([0b79f9a](https://github.com/The-Vibe-Company/companion/commit/0b79f9af172595cb84810b5d4cd65e0ed9c8e23d))
* **web:** always generate unique branch names for worktrees with forceNew ([#131](https://github.com/The-Vibe-Company/companion/issues/131)) ([cd62d4a](https://github.com/The-Vibe-Company/companion/commit/cd62d4ac8fae0b56cdef0ff850eab4a8c707f99b))
* **web:** chat scroll and composer visibility in plan mode ([#55](https://github.com/The-Vibe-Company/companion/issues/55)) ([4cff10c](https://github.com/The-Vibe-Company/companion/commit/4cff10cde297b7142c088584b6dd83060902c526))
* **web:** deduplicate messages on WebSocket reconnection ([#150](https://github.com/The-Vibe-Company/companion/issues/150)) ([a81bb3d](https://github.com/The-Vibe-Company/companion/commit/a81bb3d878957f1f18234a5f9194d1d8064f795c))
* **web:** default folder picker to home directory instead of server cwd ([#122](https://github.com/The-Vibe-Company/companion/issues/122)) ([7b8a4c7](https://github.com/The-Vibe-Company/companion/commit/7b8a4c71f32c68ffcc907269e88b3711c0d5af7a))
* **web:** enable codex web search when internet toggle is on ([#135](https://github.com/The-Vibe-Company/companion/issues/135)) ([8d9f0b0](https://github.com/The-Vibe-Company/companion/commit/8d9f0b002dcafcfc020862cb107777d75fc2580e))
* **web:** fetch and pull selected branch on session create ([#137](https://github.com/The-Vibe-Company/companion/issues/137)) ([9cdbbe1](https://github.com/The-Vibe-Company/companion/commit/9cdbbe1e151f024bd41f60e20c60e2f092ba7014))
* **web:** fix Codex approval policy and Composer mode labels ([#106](https://github.com/The-Vibe-Company/companion/issues/106)) ([fd5c2f1](https://github.com/The-Vibe-Company/companion/commit/fd5c2f15b144eb2ae9ec809fdb6ee19e797dc15a))
* **web:** fix session auto-rename and add blur-to-focus animation ([#86](https://github.com/The-Vibe-Company/companion/issues/86)) ([6d3c91f](https://github.com/The-Vibe-Company/companion/commit/6d3c91f73a65054e2c15727e90ca554af70eed28))
* **web:** fix WritableStream locked race condition in Codex adapter ([b43569d](https://github.com/The-Vibe-Company/companion/commit/b43569dbb3d154a303d60ec6bc2007b5a7bcedea))
* **web:** improve light mode contrast ([#89](https://github.com/The-Vibe-Company/companion/issues/89)) ([7ac7886](https://github.com/The-Vibe-Company/companion/commit/7ac7886fc6305e3ec45698a1c7c91b72a91c7c44))
* **web:** improve responsive design across all components ([#85](https://github.com/The-Vibe-Company/companion/issues/85)) ([0750fbb](https://github.com/The-Vibe-Company/companion/commit/0750fbbbe456d79bc104fdbdaf8f08e8795a3b62))
* **web:** isolate worktree sessions with proper branch-tracking ([#74](https://github.com/The-Vibe-Company/companion/issues/74)) ([764d7a7](https://github.com/The-Vibe-Company/companion/commit/764d7a7f5391a686408a8542421f771da341d5db))
* **web:** polyfill localStorage for Node.js 22+ ([#149](https://github.com/The-Vibe-Company/companion/issues/149)) ([602c684](https://github.com/The-Vibe-Company/companion/commit/602c6841f03677ec3f419860469e39b791968de6))
* **web:** prevent iOS auto-zoom on mobile input focus ([#102](https://github.com/The-Vibe-Company/companion/issues/102)) ([18ee23f](https://github.com/The-Vibe-Company/companion/commit/18ee23f6f1674fbcf5e1be25f8c4e23510bc12b5))
* **web:** prevent mobile keyboard layout shift and iOS zoom on branch selector ([#159](https://github.com/The-Vibe-Company/companion/issues/159)) ([4276afd](https://github.com/The-Vibe-Company/companion/commit/4276afd4390808d9d040555652c80bd1461c45b7))
* **web:** refresh git branch tracking after session start ([#195](https://github.com/The-Vibe-Company/companion/issues/195)) ([c3cb47b](https://github.com/The-Vibe-Company/companion/commit/c3cb47b56257b866b76abbb66709694cb26e0925))
* **web:** resolve [object Object] display for Codex file edit results ([#133](https://github.com/The-Vibe-Company/companion/issues/133)) ([9cc21a7](https://github.com/The-Vibe-Company/companion/commit/9cc21a78064cf07bb90174dd87bbfbd367516c90))
* **web:** resolve original repo root for worktree sessions in sidebar grouping ([#120](https://github.com/The-Vibe-Company/companion/issues/120)) ([8925ac9](https://github.com/The-Vibe-Company/companion/commit/8925ac9f540b3cd2520268539d21b0267b2dadb1))
* **web:** session reconnection with auto-relaunch and persist ([#49](https://github.com/The-Vibe-Company/companion/issues/49)) ([f58e542](https://github.com/The-Vibe-Company/companion/commit/f58e5428847a342069e6790fa7d70f190bc5f396))
* **web:** stable session ordering — sort by creation date only ([#173](https://github.com/The-Vibe-Company/companion/issues/173)) ([05c3a06](https://github.com/The-Vibe-Company/companion/commit/05c3a0652b823c5ca20b233be164a899f9920caf))
* **web:** unset CLAUDECODE env var to prevent CLI nesting guard rejec… ([#181](https://github.com/The-Vibe-Company/companion/issues/181)) ([75e264a](https://github.com/The-Vibe-Company/companion/commit/75e264a0be975dadbf3d56e64b990e0e07b12777))
* **web:** use --resume on CLI relaunch to restore conversation context ([#46](https://github.com/The-Vibe-Company/companion/issues/46)) ([3e2b5bd](https://github.com/The-Vibe-Company/companion/commit/3e2b5bdd39bd265ca5675784227a9f1b4f2a8aa3))

## [0.35.0](https://github.com/The-Vibe-Company/companion/compare/thecompanion-v0.34.5...thecompanion-v0.35.0) (2026-02-13)


### Features

* add Linux systemd support for service install/uninstall ([#169](https://github.com/The-Vibe-Company/companion/issues/169)) ([73fb3f7](https://github.com/The-Vibe-Company/companion/commit/73fb3f721efde79fec50f9c74a4f078f821c35d3))
* add MCP server management support ([#198](https://github.com/The-Vibe-Company/companion/issues/198)) ([018cf1f](https://github.com/The-Vibe-Company/companion/commit/018cf1f65ea5e281c19a39367f8cccf14ac56c1f))
* Add permission & plan approval E2E tests ([#6](https://github.com/The-Vibe-Company/companion/issues/6)) ([8590a68](https://github.com/The-Vibe-Company/companion/commit/8590a68657f0a06e94795a179ad4bbedae782c63))
* add release-please for automated npm publishing ([#24](https://github.com/The-Vibe-Company/companion/issues/24)) ([93b24ee](https://github.com/The-Vibe-Company/companion/commit/93b24ee4a12b3f32e81f59a348b25e89aaa86dce))
* allow dev server access over Tailscale/LAN ([#33](https://github.com/The-Vibe-Company/companion/issues/33)) ([9599d7a](https://github.com/The-Vibe-Company/companion/commit/9599d7ad4e2823d51c8fa262e1dcd96eeb056244))
* claude.md update ([7fa4e7a](https://github.com/The-Vibe-Company/companion/commit/7fa4e7adfdc7c409cfeed4e8a11f237ff0572234))
* **cli:** add service install/uninstall and separate dev/prod ports ([#155](https://github.com/The-Vibe-Company/companion/issues/155)) ([a4e5ba6](https://github.com/The-Vibe-Company/companion/commit/a4e5ba6ced2cc8041f61b303b0205f36e50b7594))
* **cli:** add stop and restart service commands ([#185](https://github.com/The-Vibe-Company/companion/issues/185)) ([04da8e5](https://github.com/The-Vibe-Company/companion/commit/04da8e5a3d3f0e363f662cdd6bca6145eaec479f))
* **cli:** start and stop Companion via daemon service ([#201](https://github.com/The-Vibe-Company/companion/issues/201)) ([39e2b79](https://github.com/The-Vibe-Company/companion/commit/39e2b79a6dbb70e7c7dcaf3ccbaf2116ac26b43a))
* **codex:** add offline protocol compatibility guardrails and playground coverage ([#194](https://github.com/The-Vibe-Company/companion/issues/194)) ([bf0a43e](https://github.com/The-Vibe-Company/companion/commit/bf0a43e5fdc791166e76391c0ee1ad3cf18dae10))
* Corriger menu dossier mobile et décalage clavier ([#151](https://github.com/The-Vibe-Company/companion/issues/151)) ([8068925](https://github.com/The-Vibe-Company/companion/commit/8068925f6a5ec5c6b7a40b36398bd4f9be04708d))
* e2e permissions plans ([#9](https://github.com/The-Vibe-Company/companion/issues/9)) ([53b38bf](https://github.com/The-Vibe-Company/companion/commit/53b38bfd4e773454492a3fea10e8db7ffd3fd768))
* Fix Diffs panel for worktree/relative paths and untracked files ([#165](https://github.com/The-Vibe-Company/companion/issues/165)) ([6810643](https://github.com/The-Vibe-Company/companion/commit/681064328d2bf3f4fc5c3a1867abc1536d2d54f3))
* Hide successful no-output command results ([#139](https://github.com/The-Vibe-Company/companion/issues/139)) ([a66e386](https://github.com/The-Vibe-Company/companion/commit/a66e386491e6887c5684cd70f63cc49cac0a64b7))
* **landing:** add marketing landing page for thecompanion.sh ([#128](https://github.com/The-Vibe-Company/companion/issues/128)) ([170b89c](https://github.com/The-Vibe-Company/companion/commit/170b89c72012dfb0ba68239a7665634d65275aa3))
* OpenRouter-based session auto-naming + settings page ([#168](https://github.com/The-Vibe-Company/companion/issues/168)) ([a86b1e7](https://github.com/The-Vibe-Company/companion/commit/a86b1e711ff1c38985bb3d622c6ec372a266637e))
* protocol conformance fixes and improved E2E tests ([#14](https://github.com/The-Vibe-Company/companion/issues/14)) ([51b13b9](https://github.com/The-Vibe-Company/companion/commit/51b13b9d647de6c92881b1abb61161f39152e0ef))
* Redesign README as a landing page with API-first documentation ([#7](https://github.com/The-Vibe-Company/companion/issues/7)) ([a59e1b4](https://github.com/The-Vibe-Company/companion/commit/a59e1b4604baf87faa32af7d62e4846afae49dbe))
* **sidebar:** group sound and alerts under notification ([#203](https://github.com/The-Vibe-Company/companion/issues/203)) ([0077e75](https://github.com/The-Vibe-Company/companion/commit/0077e75208e7505a53db8a829a9480a77b8c3916))
* simplified claude() API, unified endpoints, and landing page README ([#12](https://github.com/The-Vibe-Company/companion/issues/12)) ([aa2e535](https://github.com/The-Vibe-Company/companion/commit/aa2e535fe0a83b726ff2a2c08359e55973a9136b))
* The Vibe Companion complete web UI rewrite + npm package ([#23](https://github.com/The-Vibe-Company/companion/issues/23)) ([0bdc77a](https://github.com/The-Vibe-Company/companion/commit/0bdc77a81b21cd9d08ba29ea48844e73df3a1852))
* trigger release for statusline capture ([#19](https://github.com/The-Vibe-Company/companion/issues/19)) ([cedc9df](https://github.com/The-Vibe-Company/companion/commit/cedc9dfb7445344bdb43a1a756f1d2e538e08c76))
* **web:** adaptive server-side PR polling with WebSocket push ([#178](https://github.com/The-Vibe-Company/companion/issues/178)) ([57939e4](https://github.com/The-Vibe-Company/companion/commit/57939e4030a4b0e5a7dae39d93c34944e3bdff0f))
* **web:** add browser web notifications ([#191](https://github.com/The-Vibe-Company/companion/issues/191)) ([092c59a](https://github.com/The-Vibe-Company/companion/commit/092c59aff620aa2b2eac51903c01ad7cb0c4bc8e))
* **web:** add CLAUDE.md editor button in TopBar ([#170](https://github.com/The-Vibe-Company/companion/issues/170)) ([f553b9b](https://github.com/The-Vibe-Company/companion/commit/f553b9b86842f0b47c0bf24b08903e0352b7b078))
* **web:** add Clawd-inspired pixel art logo and favicon ([#70](https://github.com/The-Vibe-Company/companion/issues/70)) ([b3994ef](https://github.com/The-Vibe-Company/companion/commit/b3994eff2eac62c3cf8f40a8c31b720c910a7601))
* **web:** add component playground and ExitPlanMode display ([#36](https://github.com/The-Vibe-Company/companion/issues/36)) ([e958be7](https://github.com/The-Vibe-Company/companion/commit/e958be780f1b6e1a8f65daedbf968cdf6ef47798))
* **web:** add embedded code editor with file tree, changed files tracking, and diff view ([#81](https://github.com/The-Vibe-Company/companion/issues/81)) ([3ed0957](https://github.com/The-Vibe-Company/companion/commit/3ed095790c73edeef911ab4c73d74f1998100c5c))
* **web:** add embedded terminal in sidebar ([#175](https://github.com/The-Vibe-Company/companion/issues/175)) ([e711c5d](https://github.com/The-Vibe-Company/companion/commit/e711c5d5ef40edfa9c265642383a4c526b9b3ece))
* **web:** add git worktree support for isolated multi-branch sessions ([#64](https://github.com/The-Vibe-Company/companion/issues/64)) ([fee39d6](https://github.com/The-Vibe-Company/companion/commit/fee39d62986cd99700ba78c84a1f586331955ff8))
* **web:** add GitHub PR status to TaskPanel sidebar ([#166](https://github.com/The-Vibe-Company/companion/issues/166)) ([6ace3b2](https://github.com/The-Vibe-Company/companion/commit/6ace3b2944ec9e9082a11a45fe0798f0f5f41e55))
* **web:** add missing message-flow components to Playground ([#156](https://github.com/The-Vibe-Company/companion/issues/156)) ([ef6c27d](https://github.com/The-Vibe-Company/companion/commit/ef6c27dfa950c11b09394c74c4452c0b02aed8fb))
* **web:** add notification sound on task completion ([#99](https://github.com/The-Vibe-Company/companion/issues/99)) ([337c735](https://github.com/The-Vibe-Company/companion/commit/337c735e8267f076ada4b9ef01632d37376ec2d0))
* **web:** add OpenAI Codex CLI backend integration ([#100](https://github.com/The-Vibe-Company/companion/issues/100)) ([54e3c1a](https://github.com/The-Vibe-Company/companion/commit/54e3c1a2b359719d7983fa9ee857507e1446f505))
* **web:** add per-session usage limits with OAuth refresh and Codex support ([24ebd32](https://github.com/The-Vibe-Company/companion/commit/24ebd32f5ec617290b6b93e8bc76972a3b80d6a9))
* **web:** add permission suggestions and pending permission indicators ([10422c1](https://github.com/The-Vibe-Company/companion/commit/10422c1464b6ad4bc45eb90e6cd9ebbc0ebeac92))
* **web:** add PWA support for mobile home screen install ([#116](https://github.com/The-Vibe-Company/companion/issues/116)) ([85e605f](https://github.com/The-Vibe-Company/companion/commit/85e605fd758ee952e0d5b1dbc6f7065b514844a7))
* **web:** add update-available banner with auto-update for service mode ([#158](https://github.com/The-Vibe-Company/companion/issues/158)) ([727bd7f](https://github.com/The-Vibe-Company/companion/commit/727bd7fbd16557fd63ce41632592c1485e69713c))
* **web:** add usage limits display in session panel ([#97](https://github.com/The-Vibe-Company/companion/issues/97)) ([d29f489](https://github.com/The-Vibe-Company/companion/commit/d29f489ed9951d36ff45ec240410ffd8ffdf05eb))
* **web:** archive sessions instead of deleting them ([#56](https://github.com/The-Vibe-Company/companion/issues/56)) ([489d608](https://github.com/The-Vibe-Company/companion/commit/489d6087fc99b9131386547edaf3bd303a114090))
* **web:** enlarge homepage logo as hero element ([#71](https://github.com/The-Vibe-Company/companion/issues/71)) ([18ead74](https://github.com/The-Vibe-Company/companion/commit/18ead7436d3ebbe9d766754ddb17aa504c63703f))
* **web:** git fetch on branch picker open ([#72](https://github.com/The-Vibe-Company/companion/issues/72)) ([f110405](https://github.com/The-Vibe-Company/companion/commit/f110405edbd0f00454edd65ed72197daf0293182))
* **web:** git info display, folder dropdown fix, dev workflow ([#43](https://github.com/The-Vibe-Company/companion/issues/43)) ([1fe2069](https://github.com/The-Vibe-Company/companion/commit/1fe2069a7db17b410e383f883c934ee1662c2171))
* **web:** git worktree support with branch picker and git pull ([#65](https://github.com/The-Vibe-Company/companion/issues/65)) ([4d0c9c8](https://github.com/The-Vibe-Company/companion/commit/4d0c9c83f4fe13be863313d6c945ce0b671a7f8a))
* **web:** group sidebar sessions by project directory ([#117](https://github.com/The-Vibe-Company/companion/issues/117)) ([deceb59](https://github.com/The-Vibe-Company/companion/commit/deceb599975f53141e9c0bd6c7675437f96978b8))
* **web:** named environment profiles (~/.companion/envs/) ([#50](https://github.com/The-Vibe-Company/companion/issues/50)) ([eaa1a49](https://github.com/The-Vibe-Company/companion/commit/eaa1a497f3be61f2f71f9467e93fa2b65be19095))
* **web:** persist sessions to disk for dev mode resilience ([#45](https://github.com/The-Vibe-Company/companion/issues/45)) ([c943d00](https://github.com/The-Vibe-Company/companion/commit/c943d0047b728854f059e26facde950e08cdfe0c))
* **web:** redesign session list with avatars, auto-reconnect, and git info ([#111](https://github.com/The-Vibe-Company/companion/issues/111)) ([8a7284b](https://github.com/The-Vibe-Company/companion/commit/8a7284b3c08dc301a879924aea133945697b037a))
* **web:** replace CodeMirror editor with unified diff viewer ([#160](https://github.com/The-Vibe-Company/companion/issues/160)) ([f9b6869](https://github.com/The-Vibe-Company/companion/commit/f9b686902011ffd194a118cc1cb022bac71eaa3b))
* **web:** replace folder picker dropdown with fixed-size modal ([#76](https://github.com/The-Vibe-Company/companion/issues/76)) ([979e395](https://github.com/The-Vibe-Company/companion/commit/979e395b530cdb21e6a073ba60e33ea8ac497e2a))
* **web:** session rename persistence + auto-generated titles ([#79](https://github.com/The-Vibe-Company/companion/issues/79)) ([e1dc58c](https://github.com/The-Vibe-Company/companion/commit/e1dc58ce8ab9a619d36f2261cce89b90cfdb70d6))
* **web:** warn when branch is behind remote before session creation ([#127](https://github.com/The-Vibe-Company/companion/issues/127)) ([ef89d5c](https://github.com/The-Vibe-Company/companion/commit/ef89d5c208ca5da006aaa88b78dbd647186fb0df))


### Bug Fixes

* add web/dist to gitignore ([#2](https://github.com/The-Vibe-Company/companion/issues/2)) ([b9ac264](https://github.com/The-Vibe-Company/companion/commit/b9ac264fbb99415517636517e8f503d40fe3253d))
* always update statusLine settings on agent spawn ([#21](https://github.com/The-Vibe-Company/companion/issues/21)) ([71c343c](https://github.com/The-Vibe-Company/companion/commit/71c343cfd29fff3204ad0cc2986ff000d1be5adc))
* auto-accept workspace trust prompt and handle idle in ask() ([#16](https://github.com/The-Vibe-Company/companion/issues/16)) ([ded31b4](https://github.com/The-Vibe-Company/companion/commit/ded31b4cf9900f7ed8c3ff373ef16ae8f1e8a886))
* checkout selected branch when worktree mode is off ([#68](https://github.com/The-Vibe-Company/companion/issues/68)) ([500f3b1](https://github.com/The-Vibe-Company/companion/commit/500f3b112c5ccc646c7965344b5774efe1338377))
* **cli:** auto-update restarts service reliably via explicit systemctl/launchctl ([#208](https://github.com/The-Vibe-Company/companion/issues/208)) ([33fa67e](https://github.com/The-Vibe-Company/companion/commit/33fa67ebd75609b9a7b8700ce67b1dd949663b06))
* **cli:** expose stop/restart in help and add test ([#188](https://github.com/The-Vibe-Company/companion/issues/188)) ([c307525](https://github.com/The-Vibe-Company/companion/commit/c30752545f2137fd7c03525d5bb7f5f8851271d4))
* **cli:** fix Linux systemd service management (start, auto-restart) ([#213](https://github.com/The-Vibe-Company/companion/issues/213)) ([fc1dd65](https://github.com/The-Vibe-Company/companion/commit/fc1dd65a9fd32958d47499af1b35992a0c10fe8e))
* **cli:** refresh systemd unit file on start/restart to prevent restart loops ([#215](https://github.com/The-Vibe-Company/companion/issues/215)) ([35f80d9](https://github.com/The-Vibe-Company/companion/commit/35f80d963b1f0f0feccf7215a9bd4711b4520a12))
* **cli:** resolve binaries via user shell PATH when running as service ([#216](https://github.com/The-Vibe-Company/companion/issues/216)) ([47e4967](https://github.com/The-Vibe-Company/companion/commit/47e4967215a5bfd84c8afc2a86ce42151c73d187))
* **codex:** fix 3 critical bugs in Codex backend integration ([#147](https://github.com/The-Vibe-Company/companion/issues/147)) ([0ec92db](https://github.com/The-Vibe-Company/companion/commit/0ec92db909c7be42f94cc21d2890c9c123702dd7))
* **codex:** handle init failure gracefully and isolate per-session CODEX_HOME ([#210](https://github.com/The-Vibe-Company/companion/issues/210)) ([f4efcea](https://github.com/The-Vibe-Company/companion/commit/f4efceace6c260de92df728335678b7bded3e144))
* make service stop actually stop on macOS and refresh stale update checks ([#192](https://github.com/The-Vibe-Company/companion/issues/192)) ([f608f64](https://github.com/The-Vibe-Company/companion/commit/f608f64887bf78b2cca909aa20bd87e4a897ce94))
* remove vibe alias, update repo URLs to companion ([#30](https://github.com/The-Vibe-Company/companion/issues/30)) ([4f7b47c](https://github.com/The-Vibe-Company/companion/commit/4f7b47cba86c278e89fe81292fea9b8b3e75c035))
* scope permission requests to their session tab ([#35](https://github.com/The-Vibe-Company/companion/issues/35)) ([ef9f41c](https://github.com/The-Vibe-Company/companion/commit/ef9f41c8589e382de1db719984931bc4e91aeb11))
* show pasted images in chat history ([#32](https://github.com/The-Vibe-Company/companion/issues/32)) ([46365be](https://github.com/The-Vibe-Company/companion/commit/46365be45ae8b325100ed296617455c105d4d52e))
* **sidebar:** nest notification toggles behind disclosure ([#207](https://github.com/The-Vibe-Company/companion/issues/207)) ([87e71b8](https://github.com/The-Vibe-Company/companion/commit/87e71b8f5bf3e47c96421bca315ac412934a7dc2))
* **task-panel:** enable scrolling for long MCP sections ([#204](https://github.com/The-Vibe-Company/companion/issues/204)) ([b98abbb](https://github.com/The-Vibe-Company/companion/commit/b98abbbea4355c7e91d4dc322e53e638f4e4c542))
* track all commits in release-please, not just web/ ([#27](https://github.com/The-Vibe-Company/companion/issues/27)) ([d49f649](https://github.com/The-Vibe-Company/companion/commit/d49f64996d02807baf0482ce3c3607ae59f78638))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([e296ab0](https://github.com/The-Vibe-Company/companion/commit/e296ab0fabd6345b1f21c7094ca1f8d6f6af79cb))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([#26](https://github.com/The-Vibe-Company/companion/issues/26)) ([61eed5a](https://github.com/The-Vibe-Company/companion/commit/61eed5addd6e332fac360d9ae8239f1b0f93868e))
* use random suffixes for worktree branch names ([#88](https://github.com/The-Vibe-Company/companion/issues/88)) ([0b79f9a](https://github.com/The-Vibe-Company/companion/commit/0b79f9af172595cb84810b5d4cd65e0ed9c8e23d))
* **web:** always generate unique branch names for worktrees with forceNew ([#131](https://github.com/The-Vibe-Company/companion/issues/131)) ([cd62d4a](https://github.com/The-Vibe-Company/companion/commit/cd62d4ac8fae0b56cdef0ff850eab4a8c707f99b))
* **web:** chat scroll and composer visibility in plan mode ([#55](https://github.com/The-Vibe-Company/companion/issues/55)) ([4cff10c](https://github.com/The-Vibe-Company/companion/commit/4cff10cde297b7142c088584b6dd83060902c526))
* **web:** deduplicate messages on WebSocket reconnection ([#150](https://github.com/The-Vibe-Company/companion/issues/150)) ([a81bb3d](https://github.com/The-Vibe-Company/companion/commit/a81bb3d878957f1f18234a5f9194d1d8064f795c))
* **web:** default folder picker to home directory instead of server cwd ([#122](https://github.com/The-Vibe-Company/companion/issues/122)) ([7b8a4c7](https://github.com/The-Vibe-Company/companion/commit/7b8a4c71f32c68ffcc907269e88b3711c0d5af7a))
* **web:** enable codex web search when internet toggle is on ([#135](https://github.com/The-Vibe-Company/companion/issues/135)) ([8d9f0b0](https://github.com/The-Vibe-Company/companion/commit/8d9f0b002dcafcfc020862cb107777d75fc2580e))
* **web:** fetch and pull selected branch on session create ([#137](https://github.com/The-Vibe-Company/companion/issues/137)) ([9cdbbe1](https://github.com/The-Vibe-Company/companion/commit/9cdbbe1e151f024bd41f60e20c60e2f092ba7014))
* **web:** fix Codex approval policy and Composer mode labels ([#106](https://github.com/The-Vibe-Company/companion/issues/106)) ([fd5c2f1](https://github.com/The-Vibe-Company/companion/commit/fd5c2f15b144eb2ae9ec809fdb6ee19e797dc15a))
* **web:** fix session auto-rename and add blur-to-focus animation ([#86](https://github.com/The-Vibe-Company/companion/issues/86)) ([6d3c91f](https://github.com/The-Vibe-Company/companion/commit/6d3c91f73a65054e2c15727e90ca554af70eed28))
* **web:** fix WritableStream locked race condition in Codex adapter ([b43569d](https://github.com/The-Vibe-Company/companion/commit/b43569dbb3d154a303d60ec6bc2007b5a7bcedea))
* **web:** improve light mode contrast ([#89](https://github.com/The-Vibe-Company/companion/issues/89)) ([7ac7886](https://github.com/The-Vibe-Company/companion/commit/7ac7886fc6305e3ec45698a1c7c91b72a91c7c44))
* **web:** improve responsive design across all components ([#85](https://github.com/The-Vibe-Company/companion/issues/85)) ([0750fbb](https://github.com/The-Vibe-Company/companion/commit/0750fbbbe456d79bc104fdbdaf8f08e8795a3b62))
* **web:** isolate worktree sessions with proper branch-tracking ([#74](https://github.com/The-Vibe-Company/companion/issues/74)) ([764d7a7](https://github.com/The-Vibe-Company/companion/commit/764d7a7f5391a686408a8542421f771da341d5db))
* **web:** polyfill localStorage for Node.js 22+ ([#149](https://github.com/The-Vibe-Company/companion/issues/149)) ([602c684](https://github.com/The-Vibe-Company/companion/commit/602c6841f03677ec3f419860469e39b791968de6))
* **web:** prevent iOS auto-zoom on mobile input focus ([#102](https://github.com/The-Vibe-Company/companion/issues/102)) ([18ee23f](https://github.com/The-Vibe-Company/companion/commit/18ee23f6f1674fbcf5e1be25f8c4e23510bc12b5))
* **web:** prevent mobile keyboard layout shift and iOS zoom on branch selector ([#159](https://github.com/The-Vibe-Company/companion/issues/159)) ([4276afd](https://github.com/The-Vibe-Company/companion/commit/4276afd4390808d9d040555652c80bd1461c45b7))
* **web:** refresh git branch tracking after session start ([#195](https://github.com/The-Vibe-Company/companion/issues/195)) ([c3cb47b](https://github.com/The-Vibe-Company/companion/commit/c3cb47b56257b866b76abbb66709694cb26e0925))
* **web:** resolve [object Object] display for Codex file edit results ([#133](https://github.com/The-Vibe-Company/companion/issues/133)) ([9cc21a7](https://github.com/The-Vibe-Company/companion/commit/9cc21a78064cf07bb90174dd87bbfbd367516c90))
* **web:** resolve original repo root for worktree sessions in sidebar grouping ([#120](https://github.com/The-Vibe-Company/companion/issues/120)) ([8925ac9](https://github.com/The-Vibe-Company/companion/commit/8925ac9f540b3cd2520268539d21b0267b2dadb1))
* **web:** session reconnection with auto-relaunch and persist ([#49](https://github.com/The-Vibe-Company/companion/issues/49)) ([f58e542](https://github.com/The-Vibe-Company/companion/commit/f58e5428847a342069e6790fa7d70f190bc5f396))
* **web:** stable session ordering — sort by creation date only ([#173](https://github.com/The-Vibe-Company/companion/issues/173)) ([05c3a06](https://github.com/The-Vibe-Company/companion/commit/05c3a0652b823c5ca20b233be164a899f9920caf))
* **web:** unset CLAUDECODE env var to prevent CLI nesting guard rejec… ([#181](https://github.com/The-Vibe-Company/companion/issues/181)) ([75e264a](https://github.com/The-Vibe-Company/companion/commit/75e264a0be975dadbf3d56e64b990e0e07b12777))
* **web:** use --resume on CLI relaunch to restore conversation context ([#46](https://github.com/The-Vibe-Company/companion/issues/46)) ([3e2b5bd](https://github.com/The-Vibe-Company/companion/commit/3e2b5bdd39bd265ca5675784227a9f1b4f2a8aa3))

## [0.34.5](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.34.4...the-companion-v0.34.5) (2026-02-13)


### Bug Fixes

* **cli:** fix Linux systemd service management (start, auto-restart) ([#213](https://github.com/The-Vibe-Company/companion/issues/213)) ([fc1dd65](https://github.com/The-Vibe-Company/companion/commit/fc1dd65a9fd32958d47499af1b35992a0c10fe8e))
* **cli:** refresh systemd unit file on start/restart to prevent restart loops ([#215](https://github.com/The-Vibe-Company/companion/issues/215)) ([35f80d9](https://github.com/The-Vibe-Company/companion/commit/35f80d963b1f0f0feccf7215a9bd4711b4520a12))
* **cli:** resolve binaries via user shell PATH when running as service ([#216](https://github.com/The-Vibe-Company/companion/issues/216)) ([47e4967](https://github.com/The-Vibe-Company/companion/commit/47e4967215a5bfd84c8afc2a86ce42151c73d187))

## [0.34.4](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.34.3...the-companion-v0.34.4) (2026-02-13)


### Bug Fixes

* **codex:** handle init failure gracefully and isolate per-session CODEX_HOME ([#210](https://github.com/The-Vibe-Company/companion/issues/210)) ([f4efcea](https://github.com/The-Vibe-Company/companion/commit/f4efceace6c260de92df728335678b7bded3e144))

## [0.34.3](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.34.2...the-companion-v0.34.3) (2026-02-13)


### Bug Fixes

* **cli:** auto-update restarts service reliably via explicit systemctl/launchctl ([#208](https://github.com/The-Vibe-Company/companion/issues/208)) ([33fa67e](https://github.com/The-Vibe-Company/companion/commit/33fa67ebd75609b9a7b8700ce67b1dd949663b06))

## [0.34.2](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.34.1...the-companion-v0.34.2) (2026-02-13)


### Bug Fixes

* **sidebar:** nest notification toggles behind disclosure ([#207](https://github.com/The-Vibe-Company/companion/issues/207)) ([87e71b8](https://github.com/The-Vibe-Company/companion/commit/87e71b8f5bf3e47c96421bca315ac412934a7dc2))

## [0.34.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.34.0...the-companion-v0.34.1) (2026-02-13)


### Bug Fixes

* **task-panel:** enable scrolling for long MCP sections ([#204](https://github.com/The-Vibe-Company/companion/issues/204)) ([b98abbb](https://github.com/The-Vibe-Company/companion/commit/b98abbbea4355c7e91d4dc322e53e638f4e4c542))

## [0.34.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.33.0...the-companion-v0.34.0) (2026-02-13)


### Features

* **cli:** start and stop Companion via daemon service ([#201](https://github.com/The-Vibe-Company/companion/issues/201)) ([39e2b79](https://github.com/The-Vibe-Company/companion/commit/39e2b79a6dbb70e7c7dcaf3ccbaf2116ac26b43a))
* **sidebar:** group sound and alerts under notification ([#203](https://github.com/The-Vibe-Company/companion/issues/203)) ([0077e75](https://github.com/The-Vibe-Company/companion/commit/0077e75208e7505a53db8a829a9480a77b8c3916))

## [0.33.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.32.0...the-companion-v0.33.0) (2026-02-13)


### Features

* **web:** add browser web notifications ([#191](https://github.com/The-Vibe-Company/companion/issues/191)) ([092c59a](https://github.com/The-Vibe-Company/companion/commit/092c59aff620aa2b2eac51903c01ad7cb0c4bc8e))

## [0.32.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.31.0...the-companion-v0.32.0) (2026-02-13)


### Features

* add MCP server management support ([#198](https://github.com/The-Vibe-Company/companion/issues/198)) ([018cf1f](https://github.com/The-Vibe-Company/companion/commit/018cf1f65ea5e281c19a39367f8cccf14ac56c1f))


### Bug Fixes

* **web:** refresh git branch tracking after session start ([#195](https://github.com/The-Vibe-Company/companion/issues/195)) ([c3cb47b](https://github.com/The-Vibe-Company/companion/commit/c3cb47b56257b866b76abbb66709694cb26e0925))

## [0.31.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.30.1...the-companion-v0.31.0) (2026-02-13)


### Features

* **codex:** add offline protocol compatibility guardrails and playground coverage ([#194](https://github.com/The-Vibe-Company/companion/issues/194)) ([bf0a43e](https://github.com/The-Vibe-Company/companion/commit/bf0a43e5fdc791166e76391c0ee1ad3cf18dae10))


### Bug Fixes

* make service stop actually stop on macOS and refresh stale update checks ([#192](https://github.com/The-Vibe-Company/companion/issues/192)) ([f608f64](https://github.com/The-Vibe-Company/companion/commit/f608f64887bf78b2cca909aa20bd87e4a897ce94))

## [0.30.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.30.0...the-companion-v0.30.1) (2026-02-13)


### Bug Fixes

* **cli:** expose stop/restart in help and add test ([#188](https://github.com/The-Vibe-Company/companion/issues/188)) ([c307525](https://github.com/The-Vibe-Company/companion/commit/c30752545f2137fd7c03525d5bb7f5f8851271d4))

## [0.30.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.29.0...the-companion-v0.30.0) (2026-02-13)


### Features

* **cli:** add stop and restart service commands ([#185](https://github.com/The-Vibe-Company/companion/issues/185)) ([04da8e5](https://github.com/The-Vibe-Company/companion/commit/04da8e5a3d3f0e363f662cdd6bca6145eaec479f))

## [0.29.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.28.0...the-companion-v0.29.0) (2026-02-13)


### Features

* **web:** adaptive server-side PR polling with WebSocket push ([#178](https://github.com/The-Vibe-Company/companion/issues/178)) ([57939e4](https://github.com/The-Vibe-Company/companion/commit/57939e4030a4b0e5a7dae39d93c34944e3bdff0f))


### Bug Fixes

* **web:** unset CLAUDECODE env var to prevent CLI nesting guard rejec… ([#181](https://github.com/The-Vibe-Company/companion/issues/181)) ([75e264a](https://github.com/The-Vibe-Company/companion/commit/75e264a0be975dadbf3d56e64b990e0e07b12777))

## [0.28.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.27.1...the-companion-v0.28.0) (2026-02-12)


### Features

* **web:** add embedded terminal in sidebar ([#175](https://github.com/The-Vibe-Company/companion/issues/175)) ([e711c5d](https://github.com/The-Vibe-Company/companion/commit/e711c5d5ef40edfa9c265642383a4c526b9b3ece))

## [0.27.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.27.0...the-companion-v0.27.1) (2026-02-12)


### Bug Fixes

* **web:** stable session ordering — sort by creation date only ([#173](https://github.com/The-Vibe-Company/companion/issues/173)) ([05c3a06](https://github.com/The-Vibe-Company/companion/commit/05c3a0652b823c5ca20b233be164a899f9920caf))

## [0.27.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.26.0...the-companion-v0.27.0) (2026-02-12)


### Features

* OpenRouter-based session auto-naming + settings page ([#168](https://github.com/The-Vibe-Company/companion/issues/168)) ([a86b1e7](https://github.com/The-Vibe-Company/companion/commit/a86b1e711ff1c38985bb3d622c6ec372a266637e))
* **web:** add CLAUDE.md editor button in TopBar ([#170](https://github.com/The-Vibe-Company/companion/issues/170)) ([f553b9b](https://github.com/The-Vibe-Company/companion/commit/f553b9b86842f0b47c0bf24b08903e0352b7b078))

## [0.26.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.25.0...the-companion-v0.26.0) (2026-02-12)


### Features

* add Linux systemd support for service install/uninstall ([#169](https://github.com/The-Vibe-Company/companion/issues/169)) ([73fb3f7](https://github.com/The-Vibe-Company/companion/commit/73fb3f721efde79fec50f9c74a4f078f821c35d3))

## [0.25.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.24.0...the-companion-v0.25.0) (2026-02-12)


### Features

* Add permission & plan approval E2E tests ([#6](https://github.com/The-Vibe-Company/companion/issues/6)) ([8590a68](https://github.com/The-Vibe-Company/companion/commit/8590a68657f0a06e94795a179ad4bbedae782c63))
* add release-please for automated npm publishing ([#24](https://github.com/The-Vibe-Company/companion/issues/24)) ([93b24ee](https://github.com/The-Vibe-Company/companion/commit/93b24ee4a12b3f32e81f59a348b25e89aaa86dce))
* allow dev server access over Tailscale/LAN ([#33](https://github.com/The-Vibe-Company/companion/issues/33)) ([9599d7a](https://github.com/The-Vibe-Company/companion/commit/9599d7ad4e2823d51c8fa262e1dcd96eeb056244))
* claude.md update ([7fa4e7a](https://github.com/The-Vibe-Company/companion/commit/7fa4e7adfdc7c409cfeed4e8a11f237ff0572234))
* **cli:** add service install/uninstall and separate dev/prod ports ([#155](https://github.com/The-Vibe-Company/companion/issues/155)) ([a4e5ba6](https://github.com/The-Vibe-Company/companion/commit/a4e5ba6ced2cc8041f61b303b0205f36e50b7594))
* Corriger menu dossier mobile et décalage clavier ([#151](https://github.com/The-Vibe-Company/companion/issues/151)) ([8068925](https://github.com/The-Vibe-Company/companion/commit/8068925f6a5ec5c6b7a40b36398bd4f9be04708d))
* e2e permissions plans ([#9](https://github.com/The-Vibe-Company/companion/issues/9)) ([53b38bf](https://github.com/The-Vibe-Company/companion/commit/53b38bfd4e773454492a3fea10e8db7ffd3fd768))
* Fix Diffs panel for worktree/relative paths and untracked files ([#165](https://github.com/The-Vibe-Company/companion/issues/165)) ([6810643](https://github.com/The-Vibe-Company/companion/commit/681064328d2bf3f4fc5c3a1867abc1536d2d54f3))
* Hide successful no-output command results ([#139](https://github.com/The-Vibe-Company/companion/issues/139)) ([a66e386](https://github.com/The-Vibe-Company/companion/commit/a66e386491e6887c5684cd70f63cc49cac0a64b7))
* **landing:** add marketing landing page for thecompanion.sh ([#128](https://github.com/The-Vibe-Company/companion/issues/128)) ([170b89c](https://github.com/The-Vibe-Company/companion/commit/170b89c72012dfb0ba68239a7665634d65275aa3))
* protocol conformance fixes and improved E2E tests ([#14](https://github.com/The-Vibe-Company/companion/issues/14)) ([51b13b9](https://github.com/The-Vibe-Company/companion/commit/51b13b9d647de6c92881b1abb61161f39152e0ef))
* Redesign README as a landing page with API-first documentation ([#7](https://github.com/The-Vibe-Company/companion/issues/7)) ([a59e1b4](https://github.com/The-Vibe-Company/companion/commit/a59e1b4604baf87faa32af7d62e4846afae49dbe))
* simplified claude() API, unified endpoints, and landing page README ([#12](https://github.com/The-Vibe-Company/companion/issues/12)) ([aa2e535](https://github.com/The-Vibe-Company/companion/commit/aa2e535fe0a83b726ff2a2c08359e55973a9136b))
* The Vibe Companion complete web UI rewrite + npm package ([#23](https://github.com/The-Vibe-Company/companion/issues/23)) ([0bdc77a](https://github.com/The-Vibe-Company/companion/commit/0bdc77a81b21cd9d08ba29ea48844e73df3a1852))
* trigger release for statusline capture ([#19](https://github.com/The-Vibe-Company/companion/issues/19)) ([cedc9df](https://github.com/The-Vibe-Company/companion/commit/cedc9dfb7445344bdb43a1a756f1d2e538e08c76))
* **web:** add Clawd-inspired pixel art logo and favicon ([#70](https://github.com/The-Vibe-Company/companion/issues/70)) ([b3994ef](https://github.com/The-Vibe-Company/companion/commit/b3994eff2eac62c3cf8f40a8c31b720c910a7601))
* **web:** add component playground and ExitPlanMode display ([#36](https://github.com/The-Vibe-Company/companion/issues/36)) ([e958be7](https://github.com/The-Vibe-Company/companion/commit/e958be780f1b6e1a8f65daedbf968cdf6ef47798))
* **web:** add embedded code editor with file tree, changed files tracking, and diff view ([#81](https://github.com/The-Vibe-Company/companion/issues/81)) ([3ed0957](https://github.com/The-Vibe-Company/companion/commit/3ed095790c73edeef911ab4c73d74f1998100c5c))
* **web:** add git worktree support for isolated multi-branch sessions ([#64](https://github.com/The-Vibe-Company/companion/issues/64)) ([fee39d6](https://github.com/The-Vibe-Company/companion/commit/fee39d62986cd99700ba78c84a1f586331955ff8))
* **web:** add GitHub PR status to TaskPanel sidebar ([#166](https://github.com/The-Vibe-Company/companion/issues/166)) ([6ace3b2](https://github.com/The-Vibe-Company/companion/commit/6ace3b2944ec9e9082a11a45fe0798f0f5f41e55))
* **web:** add missing message-flow components to Playground ([#156](https://github.com/The-Vibe-Company/companion/issues/156)) ([ef6c27d](https://github.com/The-Vibe-Company/companion/commit/ef6c27dfa950c11b09394c74c4452c0b02aed8fb))
* **web:** add notification sound on task completion ([#99](https://github.com/The-Vibe-Company/companion/issues/99)) ([337c735](https://github.com/The-Vibe-Company/companion/commit/337c735e8267f076ada4b9ef01632d37376ec2d0))
* **web:** add OpenAI Codex CLI backend integration ([#100](https://github.com/The-Vibe-Company/companion/issues/100)) ([54e3c1a](https://github.com/The-Vibe-Company/companion/commit/54e3c1a2b359719d7983fa9ee857507e1446f505))
* **web:** add per-session usage limits with OAuth refresh and Codex support ([24ebd32](https://github.com/The-Vibe-Company/companion/commit/24ebd32f5ec617290b6b93e8bc76972a3b80d6a9))
* **web:** add permission suggestions and pending permission indicators ([10422c1](https://github.com/The-Vibe-Company/companion/commit/10422c1464b6ad4bc45eb90e6cd9ebbc0ebeac92))
* **web:** add PWA support for mobile home screen install ([#116](https://github.com/The-Vibe-Company/companion/issues/116)) ([85e605f](https://github.com/The-Vibe-Company/companion/commit/85e605fd758ee952e0d5b1dbc6f7065b514844a7))
* **web:** add update-available banner with auto-update for service mode ([#158](https://github.com/The-Vibe-Company/companion/issues/158)) ([727bd7f](https://github.com/The-Vibe-Company/companion/commit/727bd7fbd16557fd63ce41632592c1485e69713c))
* **web:** add usage limits display in session panel ([#97](https://github.com/The-Vibe-Company/companion/issues/97)) ([d29f489](https://github.com/The-Vibe-Company/companion/commit/d29f489ed9951d36ff45ec240410ffd8ffdf05eb))
* **web:** archive sessions instead of deleting them ([#56](https://github.com/The-Vibe-Company/companion/issues/56)) ([489d608](https://github.com/The-Vibe-Company/companion/commit/489d6087fc99b9131386547edaf3bd303a114090))
* **web:** enlarge homepage logo as hero element ([#71](https://github.com/The-Vibe-Company/companion/issues/71)) ([18ead74](https://github.com/The-Vibe-Company/companion/commit/18ead7436d3ebbe9d766754ddb17aa504c63703f))
* **web:** git fetch on branch picker open ([#72](https://github.com/The-Vibe-Company/companion/issues/72)) ([f110405](https://github.com/The-Vibe-Company/companion/commit/f110405edbd0f00454edd65ed72197daf0293182))
* **web:** git info display, folder dropdown fix, dev workflow ([#43](https://github.com/The-Vibe-Company/companion/issues/43)) ([1fe2069](https://github.com/The-Vibe-Company/companion/commit/1fe2069a7db17b410e383f883c934ee1662c2171))
* **web:** git worktree support with branch picker and git pull ([#65](https://github.com/The-Vibe-Company/companion/issues/65)) ([4d0c9c8](https://github.com/The-Vibe-Company/companion/commit/4d0c9c83f4fe13be863313d6c945ce0b671a7f8a))
* **web:** group sidebar sessions by project directory ([#117](https://github.com/The-Vibe-Company/companion/issues/117)) ([deceb59](https://github.com/The-Vibe-Company/companion/commit/deceb599975f53141e9c0bd6c7675437f96978b8))
* **web:** named environment profiles (~/.companion/envs/) ([#50](https://github.com/The-Vibe-Company/companion/issues/50)) ([eaa1a49](https://github.com/The-Vibe-Company/companion/commit/eaa1a497f3be61f2f71f9467e93fa2b65be19095))
* **web:** persist sessions to disk for dev mode resilience ([#45](https://github.com/The-Vibe-Company/companion/issues/45)) ([c943d00](https://github.com/The-Vibe-Company/companion/commit/c943d0047b728854f059e26facde950e08cdfe0c))
* **web:** redesign session list with avatars, auto-reconnect, and git info ([#111](https://github.com/The-Vibe-Company/companion/issues/111)) ([8a7284b](https://github.com/The-Vibe-Company/companion/commit/8a7284b3c08dc301a879924aea133945697b037a))
* **web:** replace CodeMirror editor with unified diff viewer ([#160](https://github.com/The-Vibe-Company/companion/issues/160)) ([f9b6869](https://github.com/The-Vibe-Company/companion/commit/f9b686902011ffd194a118cc1cb022bac71eaa3b))
* **web:** replace folder picker dropdown with fixed-size modal ([#76](https://github.com/The-Vibe-Company/companion/issues/76)) ([979e395](https://github.com/The-Vibe-Company/companion/commit/979e395b530cdb21e6a073ba60e33ea8ac497e2a))
* **web:** session rename persistence + auto-generated titles ([#79](https://github.com/The-Vibe-Company/companion/issues/79)) ([e1dc58c](https://github.com/The-Vibe-Company/companion/commit/e1dc58ce8ab9a619d36f2261cce89b90cfdb70d6))
* **web:** warn when branch is behind remote before session creation ([#127](https://github.com/The-Vibe-Company/companion/issues/127)) ([ef89d5c](https://github.com/The-Vibe-Company/companion/commit/ef89d5c208ca5da006aaa88b78dbd647186fb0df))


### Bug Fixes

* add web/dist to gitignore ([#2](https://github.com/The-Vibe-Company/companion/issues/2)) ([b9ac264](https://github.com/The-Vibe-Company/companion/commit/b9ac264fbb99415517636517e8f503d40fe3253d))
* always update statusLine settings on agent spawn ([#21](https://github.com/The-Vibe-Company/companion/issues/21)) ([71c343c](https://github.com/The-Vibe-Company/companion/commit/71c343cfd29fff3204ad0cc2986ff000d1be5adc))
* auto-accept workspace trust prompt and handle idle in ask() ([#16](https://github.com/The-Vibe-Company/companion/issues/16)) ([ded31b4](https://github.com/The-Vibe-Company/companion/commit/ded31b4cf9900f7ed8c3ff373ef16ae8f1e8a886))
* checkout selected branch when worktree mode is off ([#68](https://github.com/The-Vibe-Company/companion/issues/68)) ([500f3b1](https://github.com/The-Vibe-Company/companion/commit/500f3b112c5ccc646c7965344b5774efe1338377))
* **codex:** fix 3 critical bugs in Codex backend integration ([#147](https://github.com/The-Vibe-Company/companion/issues/147)) ([0ec92db](https://github.com/The-Vibe-Company/companion/commit/0ec92db909c7be42f94cc21d2890c9c123702dd7))
* remove vibe alias, update repo URLs to companion ([#30](https://github.com/The-Vibe-Company/companion/issues/30)) ([4f7b47c](https://github.com/The-Vibe-Company/companion/commit/4f7b47cba86c278e89fe81292fea9b8b3e75c035))
* scope permission requests to their session tab ([#35](https://github.com/The-Vibe-Company/companion/issues/35)) ([ef9f41c](https://github.com/The-Vibe-Company/companion/commit/ef9f41c8589e382de1db719984931bc4e91aeb11))
* show pasted images in chat history ([#32](https://github.com/The-Vibe-Company/companion/issues/32)) ([46365be](https://github.com/The-Vibe-Company/companion/commit/46365be45ae8b325100ed296617455c105d4d52e))
* track all commits in release-please, not just web/ ([#27](https://github.com/The-Vibe-Company/companion/issues/27)) ([d49f649](https://github.com/The-Vibe-Company/companion/commit/d49f64996d02807baf0482ce3c3607ae59f78638))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([e296ab0](https://github.com/The-Vibe-Company/companion/commit/e296ab0fabd6345b1f21c7094ca1f8d6f6af79cb))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([#26](https://github.com/The-Vibe-Company/companion/issues/26)) ([61eed5a](https://github.com/The-Vibe-Company/companion/commit/61eed5addd6e332fac360d9ae8239f1b0f93868e))
* use random suffixes for worktree branch names ([#88](https://github.com/The-Vibe-Company/companion/issues/88)) ([0b79f9a](https://github.com/The-Vibe-Company/companion/commit/0b79f9af172595cb84810b5d4cd65e0ed9c8e23d))
* **web:** always generate unique branch names for worktrees with forceNew ([#131](https://github.com/The-Vibe-Company/companion/issues/131)) ([cd62d4a](https://github.com/The-Vibe-Company/companion/commit/cd62d4ac8fae0b56cdef0ff850eab4a8c707f99b))
* **web:** chat scroll and composer visibility in plan mode ([#55](https://github.com/The-Vibe-Company/companion/issues/55)) ([4cff10c](https://github.com/The-Vibe-Company/companion/commit/4cff10cde297b7142c088584b6dd83060902c526))
* **web:** deduplicate messages on WebSocket reconnection ([#150](https://github.com/The-Vibe-Company/companion/issues/150)) ([a81bb3d](https://github.com/The-Vibe-Company/companion/commit/a81bb3d878957f1f18234a5f9194d1d8064f795c))
* **web:** default folder picker to home directory instead of server cwd ([#122](https://github.com/The-Vibe-Company/companion/issues/122)) ([7b8a4c7](https://github.com/The-Vibe-Company/companion/commit/7b8a4c71f32c68ffcc907269e88b3711c0d5af7a))
* **web:** enable codex web search when internet toggle is on ([#135](https://github.com/The-Vibe-Company/companion/issues/135)) ([8d9f0b0](https://github.com/The-Vibe-Company/companion/commit/8d9f0b002dcafcfc020862cb107777d75fc2580e))
* **web:** fetch and pull selected branch on session create ([#137](https://github.com/The-Vibe-Company/companion/issues/137)) ([9cdbbe1](https://github.com/The-Vibe-Company/companion/commit/9cdbbe1e151f024bd41f60e20c60e2f092ba7014))
* **web:** fix Codex approval policy and Composer mode labels ([#106](https://github.com/The-Vibe-Company/companion/issues/106)) ([fd5c2f1](https://github.com/The-Vibe-Company/companion/commit/fd5c2f15b144eb2ae9ec809fdb6ee19e797dc15a))
* **web:** fix session auto-rename and add blur-to-focus animation ([#86](https://github.com/The-Vibe-Company/companion/issues/86)) ([6d3c91f](https://github.com/The-Vibe-Company/companion/commit/6d3c91f73a65054e2c15727e90ca554af70eed28))
* **web:** fix WritableStream locked race condition in Codex adapter ([b43569d](https://github.com/The-Vibe-Company/companion/commit/b43569dbb3d154a303d60ec6bc2007b5a7bcedea))
* **web:** improve light mode contrast ([#89](https://github.com/The-Vibe-Company/companion/issues/89)) ([7ac7886](https://github.com/The-Vibe-Company/companion/commit/7ac7886fc6305e3ec45698a1c7c91b72a91c7c44))
* **web:** improve responsive design across all components ([#85](https://github.com/The-Vibe-Company/companion/issues/85)) ([0750fbb](https://github.com/The-Vibe-Company/companion/commit/0750fbbbe456d79bc104fdbdaf8f08e8795a3b62))
* **web:** isolate worktree sessions with proper branch-tracking ([#74](https://github.com/The-Vibe-Company/companion/issues/74)) ([764d7a7](https://github.com/The-Vibe-Company/companion/commit/764d7a7f5391a686408a8542421f771da341d5db))
* **web:** polyfill localStorage for Node.js 22+ ([#149](https://github.com/The-Vibe-Company/companion/issues/149)) ([602c684](https://github.com/The-Vibe-Company/companion/commit/602c6841f03677ec3f419860469e39b791968de6))
* **web:** prevent iOS auto-zoom on mobile input focus ([#102](https://github.com/The-Vibe-Company/companion/issues/102)) ([18ee23f](https://github.com/The-Vibe-Company/companion/commit/18ee23f6f1674fbcf5e1be25f8c4e23510bc12b5))
* **web:** prevent mobile keyboard layout shift and iOS zoom on branch selector ([#159](https://github.com/The-Vibe-Company/companion/issues/159)) ([4276afd](https://github.com/The-Vibe-Company/companion/commit/4276afd4390808d9d040555652c80bd1461c45b7))
* **web:** resolve [object Object] display for Codex file edit results ([#133](https://github.com/The-Vibe-Company/companion/issues/133)) ([9cc21a7](https://github.com/The-Vibe-Company/companion/commit/9cc21a78064cf07bb90174dd87bbfbd367516c90))
* **web:** resolve original repo root for worktree sessions in sidebar grouping ([#120](https://github.com/The-Vibe-Company/companion/issues/120)) ([8925ac9](https://github.com/The-Vibe-Company/companion/commit/8925ac9f540b3cd2520268539d21b0267b2dadb1))
* **web:** session reconnection with auto-relaunch and persist ([#49](https://github.com/The-Vibe-Company/companion/issues/49)) ([f58e542](https://github.com/The-Vibe-Company/companion/commit/f58e5428847a342069e6790fa7d70f190bc5f396))
* **web:** use --resume on CLI relaunch to restore conversation context ([#46](https://github.com/The-Vibe-Company/companion/issues/46)) ([3e2b5bd](https://github.com/The-Vibe-Company/companion/commit/3e2b5bdd39bd265ca5675784227a9f1b4f2a8aa3))

## [0.24.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.23.0...the-vibe-companion-v0.24.0) (2026-02-12)


### Features

* Fix Diffs panel for worktree/relative paths and untracked files ([#165](https://github.com/The-Vibe-Company/companion/issues/165)) ([6810643](https://github.com/The-Vibe-Company/companion/commit/681064328d2bf3f4fc5c3a1867abc1536d2d54f3))
* **web:** add GitHub PR status to TaskPanel sidebar ([#166](https://github.com/The-Vibe-Company/companion/issues/166)) ([6ace3b2](https://github.com/The-Vibe-Company/companion/commit/6ace3b2944ec9e9082a11a45fe0798f0f5f41e55))
* **web:** add update-available banner with auto-update for service mode ([#158](https://github.com/The-Vibe-Company/companion/issues/158)) ([727bd7f](https://github.com/The-Vibe-Company/companion/commit/727bd7fbd16557fd63ce41632592c1485e69713c))
* **web:** replace CodeMirror editor with unified diff viewer ([#160](https://github.com/The-Vibe-Company/companion/issues/160)) ([f9b6869](https://github.com/The-Vibe-Company/companion/commit/f9b686902011ffd194a118cc1cb022bac71eaa3b))


### Bug Fixes

* **web:** prevent mobile keyboard layout shift and iOS zoom on branch selector ([#159](https://github.com/The-Vibe-Company/companion/issues/159)) ([4276afd](https://github.com/The-Vibe-Company/companion/commit/4276afd4390808d9d040555652c80bd1461c45b7))

## [0.23.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.22.1...the-vibe-companion-v0.23.0) (2026-02-12)


### Features

* **cli:** add service install/uninstall and separate dev/prod ports ([#155](https://github.com/The-Vibe-Company/companion/issues/155)) ([a4e5ba6](https://github.com/The-Vibe-Company/companion/commit/a4e5ba6ced2cc8041f61b303b0205f36e50b7594))
* **web:** add missing message-flow components to Playground ([#156](https://github.com/The-Vibe-Company/companion/issues/156)) ([ef6c27d](https://github.com/The-Vibe-Company/companion/commit/ef6c27dfa950c11b09394c74c4452c0b02aed8fb))

## [0.22.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.22.0...the-vibe-companion-v0.22.1) (2026-02-12)


### Bug Fixes

* **web:** polyfill localStorage for Node.js 22+ ([#149](https://github.com/The-Vibe-Company/companion/issues/149)) ([602c684](https://github.com/The-Vibe-Company/companion/commit/602c6841f03677ec3f419860469e39b791968de6))

## [0.22.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.21.0...the-vibe-companion-v0.22.0) (2026-02-12)


### Features

* Corriger menu dossier mobile et décalage clavier ([#151](https://github.com/The-Vibe-Company/companion/issues/151)) ([8068925](https://github.com/The-Vibe-Company/companion/commit/8068925f6a5ec5c6b7a40b36398bd4f9be04708d))


### Bug Fixes

* **codex:** fix 3 critical bugs in Codex backend integration ([#147](https://github.com/The-Vibe-Company/companion/issues/147)) ([0ec92db](https://github.com/The-Vibe-Company/companion/commit/0ec92db909c7be42f94cc21d2890c9c123702dd7))
* **web:** deduplicate messages on WebSocket reconnection ([#150](https://github.com/The-Vibe-Company/companion/issues/150)) ([a81bb3d](https://github.com/The-Vibe-Company/companion/commit/a81bb3d878957f1f18234a5f9194d1d8064f795c))

## [0.21.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.20.3...the-vibe-companion-v0.21.0) (2026-02-11)


### Features

* Hide successful no-output command results ([#139](https://github.com/The-Vibe-Company/companion/issues/139)) ([a66e386](https://github.com/The-Vibe-Company/companion/commit/a66e386491e6887c5684cd70f63cc49cac0a64b7))

## [0.20.3](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.20.2...the-vibe-companion-v0.20.3) (2026-02-11)


### Bug Fixes

* **web:** enable codex web search when internet toggle is on ([#135](https://github.com/The-Vibe-Company/companion/issues/135)) ([8d9f0b0](https://github.com/The-Vibe-Company/companion/commit/8d9f0b002dcafcfc020862cb107777d75fc2580e))
* **web:** fetch and pull selected branch on session create ([#137](https://github.com/The-Vibe-Company/companion/issues/137)) ([9cdbbe1](https://github.com/The-Vibe-Company/companion/commit/9cdbbe1e151f024bd41f60e20c60e2f092ba7014))

## [0.20.2](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.20.1...the-vibe-companion-v0.20.2) (2026-02-11)


### Bug Fixes

* **web:** resolve [object Object] display for Codex file edit results ([#133](https://github.com/The-Vibe-Company/companion/issues/133)) ([9cc21a7](https://github.com/The-Vibe-Company/companion/commit/9cc21a78064cf07bb90174dd87bbfbd367516c90))

## [0.20.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.20.0...the-vibe-companion-v0.20.1) (2026-02-11)


### Bug Fixes

* **web:** always generate unique branch names for worktrees with forceNew ([#131](https://github.com/The-Vibe-Company/companion/issues/131)) ([cd62d4a](https://github.com/The-Vibe-Company/companion/commit/cd62d4ac8fae0b56cdef0ff850eab4a8c707f99b))

## [0.20.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.19.1...the-vibe-companion-v0.20.0) (2026-02-11)


### Features

* **landing:** add marketing landing page for thecompanion.sh ([#128](https://github.com/The-Vibe-Company/companion/issues/128)) ([170b89c](https://github.com/The-Vibe-Company/companion/commit/170b89c72012dfb0ba68239a7665634d65275aa3))
* **web:** warn when branch is behind remote before session creation ([#127](https://github.com/The-Vibe-Company/companion/issues/127)) ([ef89d5c](https://github.com/The-Vibe-Company/companion/commit/ef89d5c208ca5da006aaa88b78dbd647186fb0df))

## [0.19.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.19.0...the-vibe-companion-v0.19.1) (2026-02-11)


### Bug Fixes

* **web:** default folder picker to home directory instead of server cwd ([#122](https://github.com/The-Vibe-Company/companion/issues/122)) ([7b8a4c7](https://github.com/The-Vibe-Company/companion/commit/7b8a4c71f32c68ffcc907269e88b3711c0d5af7a))

## [0.19.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.18.1...the-vibe-companion-v0.19.0) (2026-02-11)


### Features

* **web:** add PWA support for mobile home screen install ([#116](https://github.com/The-Vibe-Company/companion/issues/116)) ([85e605f](https://github.com/The-Vibe-Company/companion/commit/85e605fd758ee952e0d5b1dbc6f7065b514844a7))

## [0.18.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.18.0...the-vibe-companion-v0.18.1) (2026-02-11)


### Bug Fixes

* **web:** resolve original repo root for worktree sessions in sidebar grouping ([#120](https://github.com/The-Vibe-Company/companion/issues/120)) ([8925ac9](https://github.com/The-Vibe-Company/companion/commit/8925ac9f540b3cd2520268539d21b0267b2dadb1))

## [0.18.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.17.1...the-vibe-companion-v0.18.0) (2026-02-11)


### Features

* **web:** group sidebar sessions by project directory ([#117](https://github.com/The-Vibe-Company/companion/issues/117)) ([deceb59](https://github.com/The-Vibe-Company/companion/commit/deceb599975f53141e9c0bd6c7675437f96978b8))
* **web:** redesign session list with avatars, auto-reconnect, and git info ([#111](https://github.com/The-Vibe-Company/companion/issues/111)) ([8a7284b](https://github.com/The-Vibe-Company/companion/commit/8a7284b3c08dc301a879924aea133945697b037a))

## [0.17.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.17.0...the-vibe-companion-v0.17.1) (2026-02-11)


### Bug Fixes

* **web:** prevent iOS auto-zoom on mobile input focus ([#102](https://github.com/The-Vibe-Company/companion/issues/102)) ([18ee23f](https://github.com/The-Vibe-Company/companion/commit/18ee23f6f1674fbcf5e1be25f8c4e23510bc12b5))

## [0.17.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.16.0...the-vibe-companion-v0.17.0) (2026-02-11)


### Features

* **web:** add per-session usage limits with OAuth refresh and Codex support ([24ebd32](https://github.com/The-Vibe-Company/companion/commit/24ebd32f5ec617290b6b93e8bc76972a3b80d6a9))


### Bug Fixes

* **web:** fix WritableStream locked race condition in Codex adapter ([b43569d](https://github.com/The-Vibe-Company/companion/commit/b43569dbb3d154a303d60ec6bc2007b5a7bcedea))

## [0.16.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.15.0...the-vibe-companion-v0.16.0) (2026-02-11)


### Features

* **web:** add usage limits display in session panel ([#97](https://github.com/The-Vibe-Company/companion/issues/97)) ([d29f489](https://github.com/The-Vibe-Company/companion/commit/d29f489ed9951d36ff45ec240410ffd8ffdf05eb))


### Bug Fixes

* **web:** fix Codex approval policy and Composer mode labels ([#106](https://github.com/The-Vibe-Company/companion/issues/106)) ([fd5c2f1](https://github.com/The-Vibe-Company/companion/commit/fd5c2f15b144eb2ae9ec809fdb6ee19e797dc15a))

## [0.15.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.14.1...the-vibe-companion-v0.15.0) (2026-02-10)


### Features

* **web:** add notification sound on task completion ([#99](https://github.com/The-Vibe-Company/companion/issues/99)) ([337c735](https://github.com/The-Vibe-Company/companion/commit/337c735e8267f076ada4b9ef01632d37376ec2d0))
* **web:** add OpenAI Codex CLI backend integration ([#100](https://github.com/The-Vibe-Company/companion/issues/100)) ([54e3c1a](https://github.com/The-Vibe-Company/companion/commit/54e3c1a2b359719d7983fa9ee857507e1446f505))


### Bug Fixes

* use random suffixes for worktree branch names ([#88](https://github.com/The-Vibe-Company/companion/issues/88)) ([0b79f9a](https://github.com/The-Vibe-Company/companion/commit/0b79f9af172595cb84810b5d4cd65e0ed9c8e23d))
* **web:** improve light mode contrast ([#89](https://github.com/The-Vibe-Company/companion/issues/89)) ([7ac7886](https://github.com/The-Vibe-Company/companion/commit/7ac7886fc6305e3ec45698a1c7c91b72a91c7c44))

## [0.14.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.14.0...the-vibe-companion-v0.14.1) (2026-02-10)


### Bug Fixes

* **web:** fix session auto-rename and add blur-to-focus animation ([#86](https://github.com/The-Vibe-Company/companion/issues/86)) ([6d3c91f](https://github.com/The-Vibe-Company/companion/commit/6d3c91f73a65054e2c15727e90ca554af70eed28))
* **web:** improve responsive design across all components ([#85](https://github.com/The-Vibe-Company/companion/issues/85)) ([0750fbb](https://github.com/The-Vibe-Company/companion/commit/0750fbbbe456d79bc104fdbdaf8f08e8795a3b62))

## [0.14.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.13.0...the-vibe-companion-v0.14.0) (2026-02-10)


### Features

* **web:** add embedded code editor with file tree, changed files tracking, and diff view ([#81](https://github.com/The-Vibe-Company/companion/issues/81)) ([3ed0957](https://github.com/The-Vibe-Company/companion/commit/3ed095790c73edeef911ab4c73d74f1998100c5c))
* **web:** session rename persistence + auto-generated titles ([#79](https://github.com/The-Vibe-Company/companion/issues/79)) ([e1dc58c](https://github.com/The-Vibe-Company/companion/commit/e1dc58ce8ab9a619d36f2261cce89b90cfdb70d6))

## [0.13.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.12.1...the-vibe-companion-v0.13.0) (2026-02-10)


### Features

* **web:** replace folder picker dropdown with fixed-size modal ([#76](https://github.com/The-Vibe-Company/companion/issues/76)) ([979e395](https://github.com/The-Vibe-Company/companion/commit/979e395b530cdb21e6a073ba60e33ea8ac497e2a))

## [0.12.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.12.0...the-vibe-companion-v0.12.1) (2026-02-10)


### Bug Fixes

* **web:** isolate worktree sessions with proper branch-tracking ([#74](https://github.com/The-Vibe-Company/companion/issues/74)) ([764d7a7](https://github.com/The-Vibe-Company/companion/commit/764d7a7f5391a686408a8542421f771da341d5db))

## [0.12.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.11.0...the-vibe-companion-v0.12.0) (2026-02-10)


### Features

* **web:** git fetch on branch picker open ([#72](https://github.com/The-Vibe-Company/companion/issues/72)) ([f110405](https://github.com/The-Vibe-Company/companion/commit/f110405edbd0f00454edd65ed72197daf0293182))

## [0.11.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.10.0...the-vibe-companion-v0.11.0) (2026-02-10)


### Features

* **web:** add Clawd-inspired pixel art logo and favicon ([#70](https://github.com/The-Vibe-Company/companion/issues/70)) ([b3994ef](https://github.com/The-Vibe-Company/companion/commit/b3994eff2eac62c3cf8f40a8c31b720c910a7601))
* **web:** enlarge homepage logo as hero element ([#71](https://github.com/The-Vibe-Company/companion/issues/71)) ([18ead74](https://github.com/The-Vibe-Company/companion/commit/18ead7436d3ebbe9d766754ddb17aa504c63703f))


### Bug Fixes

* checkout selected branch when worktree mode is off ([#68](https://github.com/The-Vibe-Company/companion/issues/68)) ([500f3b1](https://github.com/The-Vibe-Company/companion/commit/500f3b112c5ccc646c7965344b5774efe1338377))

## [0.10.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.9.0...the-vibe-companion-v0.10.0) (2026-02-10)


### Features

* **web:** git worktree support with branch picker and git pull ([#65](https://github.com/The-Vibe-Company/companion/issues/65)) ([4d0c9c8](https://github.com/The-Vibe-Company/companion/commit/4d0c9c83f4fe13be863313d6c945ce0b671a7f8a))

## [0.9.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.8.1...the-vibe-companion-v0.9.0) (2026-02-10)


### Features

* claude.md update ([7fa4e7a](https://github.com/The-Vibe-Company/companion/commit/7fa4e7adfdc7c409cfeed4e8a11f237ff0572234))
* **web:** add git worktree support for isolated multi-branch sessions ([#64](https://github.com/The-Vibe-Company/companion/issues/64)) ([fee39d6](https://github.com/The-Vibe-Company/companion/commit/fee39d62986cd99700ba78c84a1f586331955ff8))

## [0.8.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.8.0...the-vibe-companion-v0.8.1) (2026-02-10)


### Bug Fixes

* **web:** chat scroll and composer visibility in plan mode ([#55](https://github.com/The-Vibe-Company/companion/issues/55)) ([4cff10c](https://github.com/The-Vibe-Company/companion/commit/4cff10cde297b7142c088584b6dd83060902c526))

## [0.8.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.7.0...the-vibe-companion-v0.8.0) (2026-02-10)


### Features

* **web:** archive sessions instead of deleting them ([#56](https://github.com/The-Vibe-Company/companion/issues/56)) ([489d608](https://github.com/The-Vibe-Company/companion/commit/489d6087fc99b9131386547edaf3bd303a114090))

## [0.7.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.6.1...the-vibe-companion-v0.7.0) (2026-02-10)


### Features

* **web:** named environment profiles (~/.companion/envs/) ([#50](https://github.com/The-Vibe-Company/companion/issues/50)) ([eaa1a49](https://github.com/The-Vibe-Company/companion/commit/eaa1a497f3be61f2f71f9467e93fa2b65be19095))

## [0.6.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.6.0...the-vibe-companion-v0.6.1) (2026-02-10)


### Bug Fixes

* **web:** session reconnection with auto-relaunch and persist ([#49](https://github.com/The-Vibe-Company/companion/issues/49)) ([f58e542](https://github.com/The-Vibe-Company/companion/commit/f58e5428847a342069e6790fa7d70f190bc5f396))
* **web:** use --resume on CLI relaunch to restore conversation context ([#46](https://github.com/The-Vibe-Company/companion/issues/46)) ([3e2b5bd](https://github.com/The-Vibe-Company/companion/commit/3e2b5bdd39bd265ca5675784227a9f1b4f2a8aa3))

## [0.6.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.5.0...the-vibe-companion-v0.6.0) (2026-02-10)


### Features

* **web:** git info display, folder dropdown fix, dev workflow ([#43](https://github.com/The-Vibe-Company/companion/issues/43)) ([1fe2069](https://github.com/The-Vibe-Company/companion/commit/1fe2069a7db17b410e383f883c934ee1662c2171))
* **web:** persist sessions to disk for dev mode resilience ([#45](https://github.com/The-Vibe-Company/companion/issues/45)) ([c943d00](https://github.com/The-Vibe-Company/companion/commit/c943d0047b728854f059e26facde950e08cdfe0c))

## [0.5.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.4.0...the-vibe-companion-v0.5.0) (2026-02-09)


### Features

* **web:** add permission suggestions and pending permission indicators ([10422c1](https://github.com/The-Vibe-Company/companion/commit/10422c1464b6ad4bc45eb90e6cd9ebbc0ebeac92))

## [0.4.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.3.0...the-vibe-companion-v0.4.0) (2026-02-09)


### Features

* **web:** add component playground and ExitPlanMode display ([#36](https://github.com/The-Vibe-Company/companion/issues/36)) ([e958be7](https://github.com/The-Vibe-Company/companion/commit/e958be780f1b6e1a8f65daedbf968cdf6ef47798))

## [0.3.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.2.2...the-vibe-companion-v0.3.0) (2026-02-09)


### Features

* allow dev server access over Tailscale/LAN ([#33](https://github.com/The-Vibe-Company/companion/issues/33)) ([9599d7a](https://github.com/The-Vibe-Company/companion/commit/9599d7ad4e2823d51c8fa262e1dcd96eeb056244))


### Bug Fixes

* scope permission requests to their session tab ([#35](https://github.com/The-Vibe-Company/companion/issues/35)) ([ef9f41c](https://github.com/The-Vibe-Company/companion/commit/ef9f41c8589e382de1db719984931bc4e91aeb11))

## [0.2.2](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.2.1...the-vibe-companion-v0.2.2) (2026-02-09)


### Bug Fixes

* remove vibe alias, update repo URLs to companion ([#30](https://github.com/The-Vibe-Company/companion/issues/30)) ([4f7b47c](https://github.com/The-Vibe-Company/companion/commit/4f7b47cba86c278e89fe81292fea9b8b3e75c035))
* show pasted images in chat history ([#32](https://github.com/The-Vibe-Company/companion/issues/32)) ([46365be](https://github.com/The-Vibe-Company/companion/commit/46365be45ae8b325100ed296617455c105d4d52e))

## [0.2.1](https://github.com/The-Vibe-Company/claude-code-controller/compare/the-vibe-companion-v0.2.0...the-vibe-companion-v0.2.1) (2026-02-09)


### Bug Fixes

* track all commits in release-please, not just web/ ([#27](https://github.com/The-Vibe-Company/claude-code-controller/issues/27)) ([d49f649](https://github.com/The-Vibe-Company/claude-code-controller/commit/d49f64996d02807baf0482ce3c3607ae59f78638))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([e296ab0](https://github.com/The-Vibe-Company/claude-code-controller/commit/e296ab0fabd6345b1f21c7094ca1f8d6f6af79cb))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([#26](https://github.com/The-Vibe-Company/claude-code-controller/issues/26)) ([61eed5a](https://github.com/The-Vibe-Company/claude-code-controller/commit/61eed5addd6e332fac360d9ae8239f1b0f93868e))
