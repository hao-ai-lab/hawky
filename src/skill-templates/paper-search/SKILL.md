---
name: paper-search
description: Search academic papers on arXiv, Semantic Scholar, and DBLP
metadata: '{"hawky":{"emoji":"📄"}}'
---

# Paper Search

Search academic papers across multiple sources using public APIs. No CLI or API key required.

## Semantic Scholar (recommended for comprehensive search)
```bash
# Search by query (use /search/bulk — the regular /search endpoint rate-limits aggressively)
curl -s "https://api.semanticscholar.org/graph/v1/paper/search/bulk?query=efficient+LLM+inference&limit=5&fields=title,authors,year,abstract,citationCount,url" | jq '.data[] | {title, year, citationCount, url}'

# Get paper details by ID
curl -s "https://api.semanticscholar.org/graph/v1/paper/<paper_id>?fields=title,abstract,authors,year,citationCount,references.title" | jq '.'

# Search by author
curl -s "https://api.semanticscholar.org/graph/v1/author/search?query=Hao+Zhang&limit=5&fields=name,paperCount,citationCount" | jq '.data[]'
```

**Note:** The `/paper/search` endpoint returns 429 (rate limit) frequently without an API key. Prefer `/paper/search/bulk` which is more reliable. For higher limits, set `S2_API_KEY` header.

## arXiv
```bash
# Search recent papers (use https)
curl -s "https://export.arxiv.org/api/query?search_query=all:efficient+inference&max_results=5&sortBy=submittedDate&sortOrder=descending" | head -200

# Get specific paper
curl -s "https://export.arxiv.org/api/query?id_list=2401.12345" | head -100
```

## DBLP
```bash
# Search publications
curl -s "https://dblp.org/search/publ/api?q=efficient+LLM+inference&format=json&h=5" | jq '.result.hits.hit[] | {title: .info.title, venue: .info.venue, year: .info.year, url: .info.url}'
```

## Tips
- Semantic Scholar has the best API (structured JSON, citation counts, abstracts) — use `/search/bulk` to avoid rate limits
- arXiv returns XML (harder to parse but has the most recent papers). Use `https://` not `http://`
- DBLP is best for venue-specific searches. Use URL-encoded spaces (`%20`) in multi-word queries — `+` may not work as expected
- Rate limits: Semantic Scholar ~100 req/5min (bulk is more lenient), arXiv ~1 req/3sec
- For highly-cited papers, sort by citationCount
- Use `jq` to filter and format JSON output
