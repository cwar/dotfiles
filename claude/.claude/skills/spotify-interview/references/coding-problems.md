# Coding Problems Reference

## Problem Selection Guide

### By Interview Type

| Interview | Problems Per Session | Difficulty |
|-----------|---------------------|------------|
| Tech Screen | 1 problem | Medium (with follow-ups for depth) |
| Programming Final | 1-2 problems | Medium to Hard (escalating) |

### By Level

| Level | Expectations |
|-------|-------------|
| Associate | Complete basic solution with hints, struggle with optimization |
| Engineer I | Solid solution, needs some hints, discusses basics of complexity |
| Engineer II | Independent solution, clean code, explains tradeoffs |
| Senior | Multiple approaches, optimal solution, handles all edge cases |

---

## Anagram Check (Good for Tech Screen - All Domains)

**Problem:** "Write a function that checks if two given strings are anagrams of each other."

An anagram uses exactly the same characters, just rearranged.

**Examples:**
- "listen" and "silent" → true
- "pointers" and "proteins" → true
- "hello" and "world" → false
- "aab" and "aba" → true
- "aab" and "aaa" → false

**Edge case:** "Is 'abc' an anagram of 'abc'?" → Yes for this problem.

### Solutions

**Approach 1: Sort and Compare**
Sort both strings, compare. Time: O(n log n), Space: O(n). Simple, good first attempt.

```java
public boolean isAnagram(String s1, String s2) {
    if (s1.length() != s2.length()) return false;
    char[] a1 = s1.toCharArray();
    char[] a2 = s2.toCharArray();
    Arrays.sort(a1);
    Arrays.sort(a2);
    return Arrays.equals(a1, a2);
}
```

```typescript
function isAnagram(s1: string, s2: string): boolean {
    if (s1.length !== s2.length) return false;
    return s1.split('').sort().join('') === s2.split('').sort().join('');
}
```

```python
def is_anagram(s1: str, s2: str) -> bool:
    if len(s1) != len(s2):
        return False
    return sorted(s1) == sorted(s2)
```

**Approach 2: Hash Map Counting**
Count frequencies, compare. Time: O(n), Space: O(k) where k = unique chars.

```java
public boolean isAnagram(String s1, String s2) {
    if (s1.length() != s2.length()) return false;
    Map<Character, Integer> counts = new HashMap<>();
    for (char c : s1.toCharArray())
        counts.put(c, counts.getOrDefault(c, 0) + 1);
    for (char c : s2.toCharArray()) {
        int count = counts.getOrDefault(c, 0) - 1;
        if (count < 0) return false;
        counts.put(c, count);
    }
    return true;
}
```

**Approach 3: Fixed Array (lowercase only)**
Array of size 26. Time: O(n), Space: O(1).

```java
public boolean isAnagram(String s1, String s2) {
    if (s1.length() != s2.length()) return false;
    int[] counts = new int[26];
    for (int i = 0; i < s1.length(); i++) {
        counts[s1.charAt(i) - 'a']++;
        counts[s2.charAt(i) - 'a']--;
    }
    for (int count : counts) if (count != 0) return false;
    return true;
}
```

### Comparison

| Approach | Time | Space | Notes |
|----------|------|-------|-------|
| Sort & Compare | O(n log n) | O(n) | Simple, good first attempt |
| Hash Map | O(n) | O(k) | Optimal, works with any characters |
| Fixed Array | O(n) | O(1) | Best if charset is known |

### Follow-ups
- "What's the time/space complexity?"
- "Can you think of a different approach?"
- "What if the strings could contain Unicode characters?"
- Extension: "Group anagrams from a list" → Use sorted string as hash key

### What to Watch For

| Signal | Good | Concerning |
|--------|------|------------|
| First instinct | Checks length first | Jumps to complex logic |
| Approach | Explains before coding | Starts typing without plan |
| Edge cases | Asks about case/spaces/Unicode | Assumes simple input |
| Complexity | Explains why sorting is O(n log n) | Guesses or doesn't know |
| Iteration | Improves when prompted | Stuck on first approach |

---

## File Deduplication (Good for Data, ML, SRE)

**Problem:** "Given a directory, traverse all files and subdirectories. If you find duplicate files, delete the duplicate and make a hard link to the original."

**Key points:**
- Candidate should implement traversal (not use os.walk)
- Hash function for file comparison (md5 for speed, SHA for security)
- Error handling: what if file deleted during operation?

**Solution (Python):**
```python
import os
file_hashes = {}

def dedup(current, original):
    os.remove(current)
    os.link(original, current)

def traverse_fs(directory):
    for item in os.listdir(directory):
        abs_path = os.path.join(directory, item)
        if os.path.isdir(abs_path):
            traverse_fs(abs_path)
        elif os.path.isfile(abs_path):
            file_hash = get_file_hash(abs_path)
            if file_hash not in file_hashes:
                file_hashes[file_hash] = abs_path
            else:
                dedup(file_hashes[file_hash], abs_path)
```

**Follow-ups:** DFS vs BFS? Hash function choice? Cross-OS hashing? Error handling?

---

## Sum-tree (Good for Backend, Data)

**Problem:** Given a tree, find the sum of values on the path between two nodes.

Uses parent-pointer representation. Solution walks both pointers up until they meet.
Time: O(h) where h = height.

---

## Print Values in Order from Threads (Good for Backend, Core)

**Problem:** Given async threads completing in random order, print values consecutively.

Tests: Concurrency understanding, synchronization, callback patterns.

---

## Additional Problems (by domain)

### Backend
- Windowed Moving Median
- Rank Tracks (TrackStore)
- Most Common Sequence
- Model a List in Memcached
- Document Term Search

### Web / Fullstack
- Playlists (full-duration, multi-part)
- Number Wrapper (full-duration, multi-part)
- Track Plays (full-duration, multi-part)

Note: Web problems are single questions with multiple sub-questions filling the entire duration. JavaScript or TypeScript, language choice should NOT impact evaluation.

### Mobile
- iOS/Android specific coding exercises

---

## Complexity Quick Reference

**Time (fast → slow):**
O(1) → O(log n) → O(n) → O(n log n) → O(n²) → O(2ⁿ)

**Log = "how many times divide by 2?"**
- 1,000 items → ~10 steps
- 1,000,000 items → ~20 steps

**Space:**
- O(1) = constant (fixed array)
- O(n) = grows with input (copying strings)
