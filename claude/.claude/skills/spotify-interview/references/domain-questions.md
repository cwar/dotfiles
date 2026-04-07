# Domain Questions Reference

## Table of Contents
- [Backend / SRE](#backend--sre)
- [Data Engineering](#data-engineering)
- [Web / Frontend](#web--frontend)
- [Machine Learning](#machine-learning)
- [Mobile (IDE)](#mobile-ide)
- [Core / Embedded](#core--embedded)
- [Security](#security)
- [GenAI (All Domains)](#genai-all-domains)

---

## Backend / SRE

### Tech Screen Questions (pick 2-3)

**Q: REST API Design**
"If you were designing an API endpoint to update a user's profile, what HTTP method would you use and why?"
Follow-up: "What status codes would you return for success vs. validation errors?"
Look for: PUT or PATCH with reasoning, 200/204 for success, 400 for validation, 404 not found. Bonus: mentions idempotency.

**Q: Error Handling & Resilience**
"In a system where Service A calls Service B, and Service B is temporarily down, how would you handle that failure gracefully?"
Look for: Retries with backoff, timeouts, circuit breaker pattern (bonus), graceful degradation/fallback.

**Q: Database Basics**
"What's the difference between an inner join and an outer join? When would you use each?"
Look for: Inner = only matching rows; Outer = includes non-matching (left/right/full). Use cases: reporting vs. required relationships.

**Q: Event-Driven Architecture**
"Describe a scenario where you'd choose an event-driven architecture over synchronous REST calls."
Look for: Decoupling, scalability, eventual consistency awareness, examples from experience.

**Q: Caching**
"When would you introduce a cache in a backend system, and what problems can caching introduce?"
Look for: Read-heavy patterns, cache invalidation challenges, TTL strategies, cache stampede, consistency concerns.

### Backend Case Study (Final Round Domain Interview)
The Backend Case Study is a troubleshooting/problem-solving exercise. Evaluates:
- Communication & Collaboration
- Problem Solving & Troubleshooting
- System Knowledge

The interviewer acts as a stakeholder. Use FigJam/whiteboard. No coding required.

Scoring areas:
- Problem Solving: Scientific approach, checks assumptions, finds root cause
- System: Knowledge of distributed systems, incisive questions, understands tools
- Communication: Collaborative, explains reasoning, doesn't get lost in trivia

---

## Data Engineering

### Tech Screen Questions (pick 2-3)

**Q: Pipeline Design**
"Walk me through how you would design a data pipeline that processes daily user listening data and produces a report of top artists per country."
Look for: Schema design, join strategies, aggregation approach, orchestration, monitoring.

**Q: Data Quality**
"How do you ensure data quality in a production pipeline?"
Look for: Validation checks, schema enforcement, anomaly detection, data lineage, alerting.

**Q: Schema Design**
"Given a stream of user listening events, design the schema for an analytics dataset."
Look for: Field types (enums vs strings), normalization choices, partitioning strategy, evolution considerations.

**Q: Batch vs Stream**
"When would you choose batch processing over stream processing, and vice versa?"
Look for: Latency requirements, data volume, completeness vs. timeliness tradeoff, specific tech examples.

### Data Interview (Final Round)
Problem examples: "Top Artists per Country" using EndSong data.
Concepts to test: Schema/data modeling, join problems, infrastructure estimation, orchestration, monitoring, data quality.

---

## Web / Frontend

### Tech Screen Questions (pick 2-3)

**Q: State Management**
"How do you decide where to keep state in a web application — component state, context, or a global store?"
Look for: Understanding of state locality, re-render implications, when global state is needed.

**Q: Performance**
"A user reports your web page is slow. Walk me through how you'd diagnose and fix it."
Look for: DevTools profiling, network waterfall, bundle size, lazy loading, memoization, rendering bottlenecks.

**Q: Component Architecture**
"How would you design a reusable component library for a music player interface?"
Look for: Composition over inheritance, prop design, accessibility, theming considerations.

**Q: API Design**
"How would you design the frontend's interaction with a REST API that returns paginated playlists?"
Look for: Pagination strategy, loading states, error handling, caching, optimistic updates.

### Web Interview (Final Round)
Problems: Lists, Song Search, Disco Lights, My Library.
JavaScript/TypeScript (vanilla preferred). Evaluates DOM manipulation, event handling, state management, responsiveness.

---

## Machine Learning

### Tech Screen Questions (pick 2-3)

**Q: Model Selection**
"How would you approach building a model to predict which songs a user will listen to next?"
Look for: Feature engineering ideas, model selection rationale, evaluation metrics, cold start problem.

**Q: Feature Engineering**
"What features would you extract from a user's listening history to build a recommendation system?"
Look for: Temporal features, aggregations, embeddings, interaction features, feature importance.

**Q: Evaluation**
"How do you evaluate a recommendation model? What metrics would you use?"
Look for: Offline vs online metrics, A/B testing, precision/recall, NDCG, business metrics.

### ML Breadth (Final Round)
60-minute interview assessing breadth across ML techniques. Candidate designs a system using mixture of supervised/unsupervised approaches.

Example problem: "Model Active Users" - predict which users will be active next month.
Evaluates: ML breadth, feature engineering, model selection, evaluation strategy, system integration.

---

## Mobile (IDE)

### Tech Screen Questions (pick 2-3)

**Q: Architecture**
"What architecture patterns have you used in mobile development? What are the tradeoffs?"
Look for: MVC/MVVM/MVI, separation of concerns, testability, state management approach.

**Q: JSON Parsing**
"How would you design a robust JSON parsing layer for a mobile app that consumes multiple APIs?"
Look for: Codable/Decodable (iOS) or Gson/Moshi (Android), error handling, versioning, partial parsing.

**Q: UI Building**
"How do you approach building a complex scrolling list with different item types?"
Look for: RecyclerView (Android) / UICollectionView (iOS), view recycling, diffing, performance.

### IDE Interview (Final Round)
Problems: Album Guessing Game, Timezone handling.
Kotlin/Java (Android) or Swift (iOS).

---

## Core / Embedded

### Tech Screen Questions (pick 2-3)

**Q: Memory Management**
"Explain the difference between stack and heap allocation. When would you use each?"
Look for: Lifetime semantics, performance implications, RAII (C++), smart pointers.

**Q: Concurrency**
"How would you safely share data between two threads in C++?"
Look for: Mutexes, lock guards, atomic operations, lock-free patterns, awareness of deadlocks.

**Q: Performance**
"You have a function that's called millions of times per second. How would you optimize it?"
Look for: Profiling first, cache-friendly data structures, algorithmic improvements, avoiding allocations.

### Code Review (Final Round)
The candidate reviews a code sample and discusses:
- Correctness issues
- Performance concerns
- Design improvements
- Testing considerations

---

## Security

### Tech Screen Questions
Security candidates follow a separate domain interview process. Questions focus on:
- Incident response methodology
- Threat analysis and modeling
- Security infrastructure design
- Vulnerability assessment

### Security Case Study (Final Round)
Scenario-based incident response exercise. Evaluates:
- Communication & Collaboration
- Problem Solving & Troubleshooting
- Security Knowledge
- Incident Response Process

---

## GenAI (All Domains)

These questions are REQUIRED for all technical interviews (except values).

**Q1: GenAI in Daily Work**
"What GenAI tools do you use day-to-day? What do you find them most useful for?"
Look for: Actual usage vs. theoretical knowledge, specific examples (code generation, debugging, docs), awareness of limitations.

**Q2: Verifying AI Output**
"When you use AI to help write code, how do you verify the output is correct?"
Look for: Testing, code review mindset, understanding that AI can be confidently wrong, specific verification strategies.
