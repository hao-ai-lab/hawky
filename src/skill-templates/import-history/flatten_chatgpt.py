#!/usr/bin/env python3
"""
Flatten ChatGPT conversations.json tree structure into simple JSONL.

ChatGPT exports conversations as a tree (nodes with parent pointers),
not a flat list. This script walks from current_node back to root,
reverses to get chronological order, and outputs one JSON line per message.

Usage:
    python3 flatten_chatgpt.py conversations.json output.jsonl
    python3 flatten_chatgpt.py conversations.json -  # stdout
"""

import json
import sys
from datetime import datetime, timezone


def walk_conversation(conversation):
    """Walk the tree from current_node to root, yield messages in order."""
    mapping = conversation.get("mapping", {})
    current = conversation.get("current_node")
    title = conversation.get("title", "Untitled")

    # Walk backwards from current_node
    chain = []
    while current and current in mapping:
        node = mapping[current]
        msg = node.get("message")
        if msg and msg.get("content", {}).get("parts"):
            role = msg.get("author", {}).get("role", "unknown")
            if role in ("user", "assistant"):
                parts = msg["content"]["parts"]
                text_parts = []
                for p in parts:
                    if isinstance(p, str):
                        text_parts.append(p)
                    elif isinstance(p, dict) and "text" in p:
                        text_parts.append(p["text"])
                text = "\n".join(text_parts).strip()
                if text:
                    ts = msg.get("create_time")
                    chain.append({
                        "title": title,
                        "timestamp": format_timestamp(ts),
                        "role": role,
                        "text": text,
                    })
        current = node.get("parent")

    # Reverse to chronological order
    chain.reverse()
    return chain


def format_timestamp(ts):
    """Convert Unix float to ISO 8601."""
    if ts is None:
        return None
    try:
        dt = datetime.fromtimestamp(float(ts), tz=timezone.utc)
        return dt.isoformat()
    except (ValueError, TypeError, OSError):
        return None


def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <conversations.json> <output.jsonl | ->", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, "r", encoding="utf-8") as f:
        conversations = json.load(f)

    if not isinstance(conversations, list):
        conversations = [conversations]

    out = sys.stdout if output_path == "-" else open(output_path, "w", encoding="utf-8")

    total_messages = 0
    total_conversations = 0

    try:
        for conv in conversations:
            messages = walk_conversation(conv)
            if messages:
                total_conversations += 1
                for msg in messages:
                    out.write(json.dumps(msg, ensure_ascii=False) + "\n")
                    total_messages += 1
    finally:
        if out is not sys.stdout:
            out.close()

    print(f"Flattened {total_conversations} conversations, {total_messages} messages", file=sys.stderr)


if __name__ == "__main__":
    main()
