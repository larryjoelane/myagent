        ┌──────────────────────────────────┐
                   │    User Conversation Segment     │
                   └─────────────────┬────────────────┘
                                     │
                                     ▼
                   ┌──────────────────────────────────┐
                   │ 1. Vector Extraction (MiniLM)    │
                   └─────────────────┬────────────────┘
                                     │
                                     ▼
                   ┌──────────────────────────────────┐
                   │ 2. Hebbian Co-occurrence Wiring  │
                   │    (Strengthen shared edges)     │
                   └─────────────────┬────────────────┘
                                     │
                                     ▼
                   ┌──────────────────────────────────┐
                   │ 3. Memory Activation / Query     │
                   │    (Vector + Spreading Edge Search)
                   └─────────────────┬────────────────┘
                                     │
                                     ▼
                   ┌──────────────────────────────────┐
                   │ 4. Synaptic Pruning (Background) │
                   │    (Decay energy & drop nodes)   │
                   └──────────────────────────────────┘


[ Active Pipeline Query ]
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │  Tier 1: Working Memory   │
                    │   (Fast Plastic Graph)    │
                    └─────────────┬─────────────┘
                                  │
                          (If Not Found)
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │  Tier 2: Deep Enterprise  │──► Re-injects into Tier 1
                    │  Archive (Vector Database)│    with max energy
                    └───────────────────────────┘


                   // Skip decay for structural, compliance, or core policy data
if (node.metadata.isPermanent || node.metadata.category === 'compliance') {
    node.energy = 1.0; // Stay forever vital
    continue; 
}
node.energy *= decayFactor; // Decay standard casual text
