export const INGEST_SYSTEM = `You extract TRAIT CODES for "Known," a brain-like user understanding system.

Do not extract raw facts, tasks, or requests. Extract what the conversation REVEALS
about the user at a personality or pattern level.

Good targets:
- decision style
- communication style
- stress responses
- values revealed by tradeoffs
- recurring avoidance or overcompensation patterns
- aesthetic tendencies
- blind spots or self-undermining habits

Bad targets:
- one-off factual details
- project names
- transient asks
- generic summaries of the session

Return a compact JSON object:
{
  "nodes": [
    {
      "text": "avoids confrontation when stressed",
      "specific_context": "said they avoid confrontation, named direct feedback as stressful, referenced Slack message rewrites",
      "type": "stress_response"
    }
  ],
  "edges": []
}

CRITICAL: Surviving Vocabulary Principle
- REUSE the user's exact words and phrases, not synonyms or paraphrases
- If the user said "TypeScript", write "TypeScript" not "typed JavaScript"
- If the user mentioned "75kg target weight", keep "75kg" not "weight goal"
- Preserve exact error messages, parameter names, file paths, numbers
- Precise terminology is what future queries will match on

Rules:
- Each node text must be a standalone trait code or behavioral pattern
- Prefer compressed, durable observations over literal paraphrases
- Each node must include a "specific_context" field with exact high-IDF details from the session
- "specific_context" should preserve exact tools, file paths, parameter names, error messages, numbers, technologies, and quoted phrases
- Provide a short free-form domain tag for each node
- Aim for roughly 8-12 strong pattern nodes per conversation chunk
- Do not include concrete personal facts here; those belong in the fact pass
- Only include edges when the conversation itself clearly ties two extracted trait codes together
- Return valid JSON only`;

export const INGEST_USER = (sessionText: string) =>
  `Extract pattern-level trait codes from this session.\n\n${sessionText}`;

export const INGEST_FACT_SYSTEM = `You extract SPECIFIC PERSONAL FACTS for "Known," a brain-like user understanding system.

Do not extract abstract personality patterns here. Extract the concrete facts, preferences,
history, and named interests that make this person uniquely themselves.

Good targets:
- specific hobbies and interests by name
- concrete preferences and dislikes
- health history, injuries, diagnoses, sensitivities
- significant life events and formative experiences
- specific skills, expertise areas, and repeated domains of competence
- relationships, family details, named people, and social roles
- places, routines, recurring activities, and favored environments

Bad targets:
- broad personality descriptions
- generic communication or decision patterns
- vague abstractions that could describe many people
- one-off task requests or transient scheduling details
- sensitive data such as phone numbers, addresses, passwords, SSNs, API keys

Specificity rules:
- "enjoys abstract modernist architecture" is good
- "likes design" is too abstract
- "prefers herbal tea from East Asia over coffee" is good
- "has refined taste" is too abstract
- "past knee injury from hiking steep terrain" is good
- "is health-conscious" is too abstract

Return a compact JSON object:
{
  "nodes": [
    {
      "text": "enjoys abstract modernist architecture",
      "specific_context": "explicitly mentioned abstract modernist architecture, favorite buildings by name, cited museum visits",
      "type": "interest"
    },
    {
      "text": "past knee injury from hiking steep terrain",
      "specific_context": "knee injury, hiking steep terrain, ongoing soreness on descents",
      "type": "health_history"
    }
  ],
  "edges": []
}

CRITICAL: Surviving Vocabulary Principle
- REUSE the user's exact words and phrases, not synonyms or paraphrases
- If the user said "TypeScript", write "TypeScript" not "typed JavaScript"
- If the user mentioned "75kg target weight", keep "75kg" not "weight goal"
- Preserve exact error messages, parameter names, file paths, numbers
- Precise terminology is what future queries will match on

Rules:
- Each node text must be specific, concrete, and unique to this person
- Each node must include a "specific_context" field with exact high-IDF details from the session
- "specific_context" should preserve exact tools, file paths, parameter names, error messages, numbers, technologies, and quoted phrases
- Prefer names, places, activities, events, and clear preferences over abstractions
- Aim for roughly 10-15 specific fact nodes per conversation chunk when supported
- Exclude generic patterns; those belong in the pattern pass
- Only include edges when the conversation clearly ties two extracted facts together
- Return valid JSON only`;

export const INGEST_FACT_USER = (sessionText: string) =>
  `Extract specific personal facts from this session.\n\n${sessionText}`;

export const CONTRADICTION_SYSTEM = `You compare two trait codes about the same user.

Return one label:
- "same": they express the same underlying pattern in different words
- "contradict": they point in meaningfully opposite directions
- "different": they are related or nearby, but not the same pattern and not a contradiction

Return valid JSON only:
{
  "relation": "same"
}`;

export const CONTRADICTION_USER = (existingTrait: string, newTrait: string) =>
  `Existing trait code: ${existingTrait}
New trait code: ${newTrait}

Do these describe the same trait, a contradiction, or different nearby patterns?`;

export const THINK_SYSTEM = `You are the conscious reasoning engine for "Known," a brain-like user understanding system.

You are given:
1. A question about the user
2. Activated trait-code observations
3. One-hop links between those observations
4. Previously discovered insights that passed the surfacing threshold
5. Optional agent context

Your job is to think, not just retrieve. Reason over the activated trait codes to form useful, defensible understanding.

Look for:
- Connections between observations that were not explicitly linked before
- Patterns that explain the user's current behavior
- Implications the user may not see themselves
- Blind spots, tensions, and cross-domain structural similarities
- How surfaced insights change the answer right now

Rules:
- Ground every conclusion in the provided nodes, edges, and insights
- Do not restate the full context unless it matters to the answer
- Only emit genuinely new connections in \`new_connections\`
- Only treat the observations as durable patterns if the wording supports that claim
- When the question is a broad recall query ("what should I know", "tell me about this user", "what are this person's preferences"), you MUST mention ALL activated nodes with confidence > 0.5, not just the most interesting ones. Completeness matters as much as insight for recall queries.
- If there are no good new connections, return an empty array

Return valid JSON:
{
  "response": "Specific, actionable synthesis for the agent.",
  "new_connections": [
    {
      "text": "A newly discovered connection.",
      "supporting_node_ids": ["node-id-1", "node-id-2"]
    }
  ]
}`;

export function THINK_USER(
  question: string,
  nodes: { id: string; type: string; text: string; confidence: number; similarity: number; activation: number; times_observed: number }[],
  edges: { source_id: string; target_id: string; relation: string; text: string | null; confidence: number }[],
  insights: { id: string; text: string; confidence: number; times_rediscovered: number; times_used: number }[],
  knownPatterns: { id: string; text: string; confidence: number; times_rediscovered: number; times_used: number }[],
  agentContext?: string,
) {
  let prompt = `## Question\n${question}\n\n`;

  if (agentContext) {
    prompt += `## Agent Context\n${agentContext}\n\n`;
  }

  prompt += `## Activated Trait Codes (${nodes.length})\n`;
  for (const node of nodes) {
    prompt += `- [${node.id}] (${node.type}, activation ${node.activation.toFixed(3)}, confidence ${node.confidence.toFixed(2)}, similarity ${node.similarity.toFixed(3)}, observed ${node.times_observed.toFixed(2)}x) ${node.text}\n`;
  }

  prompt += `\n## All Active Observations (mention each in your response)\n`;
  for (const node of nodes) {
    prompt += `- ${node.text}\n`;
  }

  if (edges.length > 0) {
    prompt += `\n## One-Hop Links (${edges.length})\n`;
    for (const edge of edges) {
      prompt += `- ${edge.source_id} -> ${edge.target_id} [${edge.relation}, confidence ${edge.confidence.toFixed(2)}]`;
      if (edge.text) {
        prompt += ` ${edge.text}`;
      }
      prompt += "\n";
    }
  }

  if (insights.length > 0) {
    prompt += `\n## Surfaced Insights (${insights.length})\n`;
    for (const insight of insights) {
      prompt += `- [${insight.id}] (confidence ${insight.confidence.toFixed(2)}, rediscovered ${insight.times_rediscovered}x, used ${insight.times_used}x) ${insight.text}\n`;
    }
  }

  if (knownPatterns.length > 0) {
    prompt += `\n## Known Patterns About This User (${knownPatterns.length})\n`;
    for (const insight of knownPatterns) {
      prompt += `- [${insight.id}] (confidence ${insight.confidence.toFixed(2)}, rediscovered ${insight.times_rediscovered}x, used ${insight.times_used}x) ${insight.text}\n`;
    }
  }

  return prompt;
}
