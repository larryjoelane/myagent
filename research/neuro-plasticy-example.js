import { pipeline } from '@xenova/transformers';

// Simple graph node structure to track memory states
class MemoryNode {
    constructor(id, text, vector) {
        this.id = id;
        this.text = text;
        this.vector = vector;
        this.energy = 1.0; // Biological health of the memory node
        this.lastAccessed = Date.now();
    }
}

export class PlasticMemorySpace {
    constructor() {
        this.nodes = new Map();     // id -> MemoryNode
        this.edges = new Map();     // "idA-idB" -> weight integer
        this.embedder = null;
    }

    // Lazy load the model to avoid blocking constructor
    async init() {
        if (!this.embedder) {
            this.embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        }
    }

    // Helper math tool: compute cosine similarity between two vectors
    _cosineSimilarity(vecA, vecB) {
        let dotProduct = 0.0;
        let normA = 0.0;
        let normB = 0.0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    // Get raw vector from Xenova pipeline and average the token tensors
    async _getEmbedding(text) {
        await this.init();
        const output = await this.embedder(text);
        
        // Extract dimensions safely from the tensor format
        const data = output.data;
        const dims = output.dims; // [batch, sequence_length, embedding_dim]
        const embeddingDim = dims[2];
        const numTokens = dims[1];

        // Mean pooling over the token sequence to produce a single sentence vector
        const vector = new Float32Array(embeddingDim);
        for (let t = 0; t < numTokens; t++) {
            for (let d = 0; d < embeddingDim; d++) {
                vector[d] += data[t * embeddingDim + d];
            }
        }
        return vector.map(val => val / numTokens);
    }

    // Generate a unique deterministic ID string for text strings
    _generateId(text) {
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            hash = (hash << 5) - hash + text.charCodeAt(i);
            hash |= 0; // Convert to 32bit integer
        }
        return `node_${Math.abs(hash)}`;
    }

    /**
     * Simulates Hebbian learning ("neurons that fire together, wire together").
     * Pass an array of contextually linked text strings observed in a single conversational interaction.
     */
    async learnNewInteraction(textSegments) {
        const currentBatchIds = [];

        // 1. Process and save nodes
        for (const text of textSegments) {
            const id = this._generateId(text);
            currentBatchIds.push(id);

            if (!this.nodes.has(id)) {
                const vector = await this._getEmbedding(text);
                this.nodes.set(id, new MemoryNode(id, text, vector));
            } else {
                // Reinforce base node energy if it reappears
                const existingNode = this.nodes.get(id);
                existingNode.energy = 1.0;
                existingNode.lastAccessed = Date.now();
            }
        }

        // 2. Build or strengthen biological synaptic connections (Edges)
        for (let i = 0; i < currentBatchIds.length; i++) {
            for (let j = i + 1; j < currentBatchIds.length; j++) {
                const idA = currentBatchIds[i];
                const idB = currentBatchIds[j];
                
                // Sort keys alphabetically to avoid directional duplicates
                const edgeKey = idA < idB ? `${idA}__${idB}` : `${idB}__${idA}`;

                if (this.edges.has(edgeKey)) {
                    // Synaptic reinforcement
                    this.edges.set(edgeKey, this.edges.get(edgeKey) + 1.0);
                } else {
                    // New synaptic connection formed
                    this.edges.set(edgeKey, 1.0);
                }
            }
        }
    }

    /**
     * Normalizes and queries memory space using combination of Vector + Spreading Edge Activation
     */
    async queryPlasticMemory(queryText, topK = 3) {
        const queryVector = await this._getEmbedding(queryText);
        const scores = new Map(); // id -> total activation score

        // Phase 1: Semantic Vector Activation
        for (const [id, node] of this.nodes.entries()) {
            const similarity = this._cosineSimilarity(queryVector, node.vector);
            // Multiply similarity by current node vitality/energy
            scores.set(id, similarity * node.energy);
        }

        // Sort to get top raw vector hits
        const directHits = [...scores.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, topK);

        // Phase 2: Spreading Edge Activation (Associative Thinking)
        const spreadAmount = 0.3; // How much energy cascades along synaptic links
        for (const [hitId, hitScore] of directHits) {
            // Refresh energy for hits as they are pulled into short term consciousness
            const node = this.nodes.get(hitId);
            node.energy = Math.min(1.0, node.energy + 0.2);
            node.lastAccessed = Date.now();

            // Find all connected edges
            for (const [edgeKey, weight] of this.edges.entries()) {
                if (edgeKey.includes(hitId)) {
                    const neighborId = edgeKey.replace(hitId, '').replace('__', '');
                    if (this.nodes.has(neighborId)) {
                        // Spread score proportional to synaptic weight strength
                        const structuralBoost = hitScore * (weight * spreadAmount);
                        scores.set(neighborId, (scores.get(neighborId) || 0) + structuralBoost);
                    }
                }
            }
        }

        // Final sort of total aggregated context energies
        return [...scores.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, topK)
            .map(([id, score]) => ({
                text: this.nodes.get(id).text,
                activationScore: score,
                energy: this.nodes.get(id).energy
            }));
    }

    /**
     * Simulates synaptic pruning. Run this on a chronological timer (e.g. daily/hourly).
     * Shrinks memory node strengths and clips off dead data.
     */
    biologicalDecay(decayFactor = 0.90, biologicalCutoff = 0.15) {
        const deadNodeIds = new Set();

        // 1. Decay Node Energies
        for (const [id, node] of this.nodes.entries()) {
            node.energy *= decayFactor;
            if (node.energy < biologicalCutoff) {
                deadNodeIds.add(id);
                this.nodes.delete(id);
            }
        }

        // 2. Clean out unanchored synapses (edges)
        for (const edgeKey of this.edges.keys()) {
            const [idA, idB] = edgeKey.split('__');
            if (deadNodeIds.has(idA) || deadNodeIds.has(idB)) {
                this.edges.delete(edgeKey);
            }
        }
        return deadNodeIds.size; // Returns count of pruned thoughts
    }
}
