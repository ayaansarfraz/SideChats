# Project Context

## Problem

AI chat interfaces are too linear.

When a user is working through a long ChatGPT or Claude conversation, they often encounter a small concept, term, or sentence they want clarified.

Today they either:

1. Ask the clarification in the main chat, which pollutes and lengthens the conversation.
2. Open a new chat, which loses the context of the original conversation.

## Product Idea

Allow users to create contextual side conversations from any part of an existing AI conversation.

A user should be able to highlight text from ChatGPT or Claude and open a small side panel where they can ask follow-up questions.

The side conversation inherits enough context from the parent conversation to understand what the user is referring to, but does not modify or clutter the parent conversation.

Think of this as:

"Browser tabs for AI conversations."

or

"Contextual branches for AI chats."

## Example

Main Chat:

User:
Explain why every tree has at most one perfect matching.

AI:
[Explanation containing the phrase "symmetric difference"]

User highlights:
"symmetric difference"

Then opens a side chat.

Side Chat:

User:
What does this mean here?

AI:
Explains symmetric difference specifically in the context of the proof.

User:
Why does that create cycles?

AI:
Explains.

The user closes the side chat and continues the original conversation unchanged.

## Core UX

MVP interaction:

1. User installs a browser extension.
2. User opens ChatGPT or Claude.
3. User highlights text in an AI response.
4. A small "Ask" button appears.
5. Clicking it opens a side panel.
6. The side panel receives:
   - selected text
   - parent AI response
   - parent user message
   - relevant conversation context
7. User can have a short conversation inside the side panel.
8. Closing the side panel returns them to the main conversation.

## Initial Target User

People using AI for learning and technical work.

Examples:
- students
- developers
- researchers

Studying is the clearest initial use case.

Example:

An AI response says:

"The kernel performs a context switch after the thread exhausts its timeslice."

The user highlights "timeslice" and asks:

"What does this mean?"

The side chat understands that the question is about operating-system thread scheduling.

## Key Product Principle

Side questions should not pollute the main conversation.

The product should distinguish between:

- primary conversation
- temporary exploratory conversation

## Conversation Model

Traditional AI chats are linear:

Message
↓
Message
↓
Message
↓
Message

This product treats conversations more like trees:

Main conversation
├── Side thread
├── Side thread
└── Next main message

Branches inherit context from their parent.

## MVP

Do NOT build a full alternative ChatGPT interface initially.

Build a browser extension supporting ChatGPT first, potentially Claude afterward.

MVP:

- detect AI messages
- allow text highlighting
- show an "Ask" action
- open a sidebar
- send selected text + relevant context to an LLM API
- maintain a short side conversation
- allow closing/reopening the branch

## Context Strategy

The browser extension cannot rely on ChatGPT or Claude exposing their internal conversation/model state.

Instead, construct a context package.

Example:

SYSTEM:
You are answering a clarification about an existing AI conversation.

PARENT USER MESSAGE:
...

PARENT AI RESPONSE:
...

SELECTED TEXT:
...

OPTIONAL RELEVANT PRIOR CONTEXT:
...

USER QUESTION:
...

Initially, sending the last few relevant messages is acceptable.

Later, context selection can become smarter using:

- conversation summaries
- embeddings
- retrieval
- branch relationships
- relevance ranking

## Future Features

Do not prioritize these for the first version.

Possible later features:

### Persistent branches

A message can have multiple side conversations attached to it.

### Reopen branches

Show that a message has existing side threads.

### Promote to main

A useful side conversation can be summarized and merged back into the main conversation.

### Branch tree

Visualize relationships between parent conversations and branches.

### Automatic context retrieval

Instead of sending the whole conversation, retrieve only the information relevant to the selected text and question.

### Cross-model support

Potentially allow the user to choose OpenAI, Anthropic, Gemini, etc. for side conversations.

## Product Philosophy

The product should feel lightweight.

Opening a side question should feel more like:

- opening a browser tab
- opening a tooltip
- opening a code editor peek window

rather than starting another full AI conversation.

Speed and low friction are extremely important.

## Current Goal

Build the smallest usable prototype that answers this question:

"While using ChatGPT or Claude, do users frequently prefer asking clarification questions in contextual side threads instead of adding them to the main conversation?"