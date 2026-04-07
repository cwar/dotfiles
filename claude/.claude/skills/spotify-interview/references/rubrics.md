# Detailed Rubrics Reference

All rubrics use the standard 1-4 scale. See `leveling.md` for level descriptions.

## Table of Contents
- [Communication & Collaboration (All Types)](#communication--collaboration)
- [Tech Screen Rubric](#tech-screen-rubric)
- [System Design Rubric](#system-design-rubric)
- [Programming Rubric](#programming-rubric)
- [Backend Case Study Rubric](#backend-case-study-rubric)

---

## Communication & Collaboration
*Used across all interview types*

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Little/no effort to communicate as partner | Communicates only when stuck | Involves interviewer as team member, fluid conversation | Solution built in partnership, ensures interviewer follows |
| Interviewer frequently asks for clarification | Only clarifies own confusion | Occasionally checks understanding | Makes sure interviewer understands all decisions |

---

## Tech Screen Rubric

### Architectural Understanding (Project Discussion)

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Cannot describe system architecture | Understands components but not connections | Explains design decisions and tradeoffs | Deep understanding, identifies improvements, cross-system thinking |
| Cannot explain own project decisions | Knows what was built but not why | Articulates rationale for choices | Evaluates alternatives and their implications |

### Problem Solving

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Cannot conceive any solution | Basic/naive approach only, needs significant help | Outlines solution beyond naive, independently, covers most cases | Clarifies scope first, articulates multiple approaches with pros/cons |
| Can describe basic approach but can't implement | Final solution misses edge cases | 1-2 hints understood quickly | Recognizes and solves edge cases unprompted |

### Code Fluency

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Doesn't know basic constructs (loops, conditionals) | Struggles, needs interviewer help, poor stdlib knowledge | Codes fluently, uses stdlib appropriately | Fluent idiomatic code, thought translates directly to code |
| Cannot invoke functions correctly | Nonsensical variable names | Clean, uses placeholders effectively | Full code understanding and nuanced critique |
| Cannot read provided code | Understands general purpose with prompting | Understands purpose quickly | Understands full behavior and suggests improvements |

### Testing

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Doesn't test unless prompted | Tests some cases, misses corner cases | Tests corner cases before coding | Knows different strategies/levels and when to use each |

---

## System Design Rubric

### Knowledge of Technologies (Domain Depth)

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Picks obviously wrong tech | Lacks familiarity, superficial understanding | Good knowledge, reasonable assumptions | Discusses pros/cons, explains tech fit |
| | Can't speak to alternatives | | Identifies problematic areas and works around them |

### Awareness of Side-Effects & Informed Decision Making

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| No consideration of side-effects | Misses some but addresses when prompted | Revisits decisions to address side-effects | All side-effects considered, no blind spots |
| No clear decisions | Decisions missing context/tradeoffs | Nearly all decisions clear and unambiguous | Decisions made only with all context identified |

### Scalable & Flexible Design

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Not adaptable or scalable | Not scalable but identifies opportunities | Adapted for probable future needs | Adapted for many possible future needs |

### System Engineering & Operations

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Cannot elaborate on operational topics | Aware of limitations with hints | Determines storage/service requirements | Reasons about global workload, replication |
| Unfamiliar with Level 2 topics | | Articulates durability, resiliency, DR | Plans backups, backfills, disaster recovery |
| | | | Asks about event/request rate distributions |

### Distributed Computing (Data Eng Only)

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Cannot elaborate | Some knowledge gaps, basic understanding | Mentions frameworks (Spark, Kafka, etc.) | Discusses implementation details and tradeoffs |
| | Way too many machines, expensive | Appropriate cluster sizing | Discusses fault tolerance, replication, partitioning |
| | Non-scalable SQL components | Basic efficiency | |

### Web Applications & Services (Web/Fullstack Only)

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| [FE] No separation of state/DOM | [FE] Unclear state schema | [FE] Clear state schema and component layout | [FE] Compares state management strategies |
| [FE] Can't address responsiveness/perf | [FE] Identifies bottlenecks, unsure of solutions | [FE] Responsive behavior, identifies bottleneck solutions | [FE] Compares solutions (memoization, batch DOM) |
| [FS] Can't define API contract | [FS] Incomplete API contract | [FS] Clear API, correct status codes, auth considered | [FS] Specific tech (REST/GraphQL), CORS, cache headers |
| [FS] Can't identify network bottlenecks | [FS] Some bottlenecks, trouble optimizing | [FS] Key bottlenecks + basic strategies (CDN, caching) | [FS] CDN, lazy-loading, SSR, real-time comms |

---

## Programming Rubric

### Problem Solving

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Cannot conceive any solution | Basic/naive approach only, needs significant help | Solution beyond naive, independently, covers most cases | Clarifies scope, multiple approaches, pros/cons, full implementation |
| Can describe but can't implement | Misses edge cases | Hints understood quickly, states assumptions | Recognizes edge cases unprompted |

### Code Fluency

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Doesn't know basic constructs | Struggles, needs help | Codes fluently, uses stdlib | Fluent idiomatic code |
| Can't read code | Understands general purpose | Understands quickly | Full understanding, suggests improvements |

### Testing

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Doesn't test unless prompted | Some cases, misses corners | Corner cases before coding | Knows strategies/levels |

### Error Handling (Optional)

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Ignores exceptions, catch-alls | Basic error handling | Good strategy, validates input | Stability patterns (timeouts, retries, circuit breakers) |

### Performance (Optional)

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Doesn't understand Big O | Good single-machine solution | Distributed solution, reasonable approach | Knows different tooling, underlying concepts, tradeoffs |
| | Understands limitations but can't scale | | |

---

## Backend Case Study Rubric

### Problem Solving & Troubleshooting

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Unreasonable conclusions | Not thoughtful, stuck on trivia | Checks assumptions, good scope decisions | Scientific approach, initial fix + long-term resolution |
| Rashly jumps in, compounds problem | Fails to verify ideas | Finds root cause with some help | Top-down, verifiable tests, clear justification |

### System Knowledge

| Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|
| Cannot elaborate | Some understanding, can't grasp complex topics | Knows the material, missing some details | Comprehensive distributed systems knowledge |
| | | Good questions, occasional rabbit holes | Incisive questions, reveals new problem areas |
