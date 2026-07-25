## Project Structure
```text
.
├── ENTERPRISE.md
├── README.md
├── package-lock.json
├── package.json
├── playwright.config.ts
├── public
│   ├── app.js
│   ├── index.html
│   └── style.css
├── src
│   ├── cli.ts
│   ├── kb
│   │   └── cache.ts
│   ├── llm
│   │   ├── backoff.ts
│   │   ├── gemini.ts
│   │   ├── groq.ts
│   │   ├── json.ts
│   │   └── keyPool.ts
│   ├── orchestrator.ts
│   ├── runStore.ts
│   ├── schema
│   │   ├── appModel.ts
│   │   └── ir.ts
│   ├── server
│   │   ├── concurrency.ts
│   │   ├── index.ts
│   │   └── runRegistry.ts
│   └── stages
│       ├── credentials.ts
│       ├── discovery.ts
│       ├── executor.ts
│       ├── failureAnalysis.ts
│       ├── generator.ts
│       ├── ir.ts
│       ├── liveExtend.ts
│       ├── planner.ts
│       ├── targetResolver.ts
│       └── testCases.ts
└── tsconfig.json

8 directories, 33 files
```
