// Etsy Research Pro — Concept Clustering Module
// Built from scratch to group related Etsy search queries using token Jaccard similarity
// and tag graph co-occurrence, avoiding verbatim third-party code.

// English Stopwords for Filtering Noise
const STOPWORDS_EN = new Set([
  'a', 'an', 'and', 'or', 'the', 'of', 'for', 'to', 'in', 'on', 'with', 'by', 'from',
  'at', 'as', 'is', 'it', 'this', 'that', 'these', 'those', 'be', 'are', 'was', 'were',
  'my', 'your', 'our', 'their', 'his', 'her', 'its', 'i', 'you', 'we', 'they', 'he', 'she',
  'not', 'no', 'but', 'so', 'if', 'then', 'than', 'too', 'very', 'just', 'also', 'more',
  'most', 'any', 'all', 'some', 'each', 'every', 'such', 'own', 'same', 'other', 'new',
  'best', 'top', 'cute', 'cool', 'nice', 'pretty', 'perfect', 'great', 'super', 'ultimate',
  'custom', 'personalized', 'unique', 'handmade', 'vintage', 'gift', 'gifts', 'idea', 'ideas',
  'style', 'design', 'designs', 'set', 'sets', 'pack', 'packs', 'bundle', 'bundles',
  'print', 'prints', 'printable', 'digital', 'download', 'downloadable', 'file', 'files',
  'svg', 'png', 'jpg', 'jpeg', 'pdf', 'eps', 'dxf', 'ai', 'psd', 'cricut', 'silhouette',
  'instant', 'ready', 'easy', 'quick', 'simple', 'fun', 'modern', 'classic', 'trendy'
]);

// Spanish Stopwords for Multi-language Support
const STOPWORDS_ES = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'y', 'o', 'u',
  'e', 'en', 'con', 'por', 'para', 'sin', 'sobre', 'entre', 'hasta', 'desde', 'como',
  'que', 'qué', 'cual', 'cuál', 'quien', 'quién', 'donde', 'dónde', 'cuando', 'cuándo',
  'es', 'son', 'ser', 'estar', 'está', 'están', 'fue', 'fueron', 'era', 'eran', 'soy',
  'eres', 'somos', 'sois', 'mi', 'tu', 'su', 'nuestro', 'vuestro', 'mis', 'tus', 'sus',
  'yo', 'tú', 'él', 'ella', 'nosotros', 'vosotros', 'ellos', 'ellas', 'me', 'te', 'se',
  'le', 'lo', 'nos', 'os', 'les', 'no', 'sí', 'si', 'ni', 'pero', 'mas', 'aunque', 'porque',
  'muy', 'mucho', 'poco', 'más', 'menos', 'tan', 'tanto', 'todo', 'toda', 'todos', 'todas',
  'otro', 'otra', 'otros', 'otras', 'mismo', 'misma', 'cada', 'algún', 'alguna', 'ningún',
  'ninguna', 'nuevo', 'nueva', 'mejor', 'regalo', 'regalos', 'idea', 'ideas', 'estilo',
  'diseño', 'diseños', 'personalizado', 'personalizada', 'único', 'única', 'hecho',
  'hecha', 'mano', 'descarga', 'imprimible', 'digital', 'archivo', 'archivos'
]);

/**
 * Resolves the active set of stopwords based on language settings.
 */
export function resolveStopwords(languagesCsv) {
  const selectedStopwords = new Set();
  const languages = String(languagesCsv || 'en,es')
    .toLowerCase()
    .split(',')
    .map(lang => lang.trim());

  if (languages.includes('en')) {
    for (const word of STOPWORDS_EN) {
      selectedStopwords.add(word);
    }
  }
  if (languages.includes('es')) {
    for (const word of STOPWORDS_ES) {
      selectedStopwords.add(word);
    }
  }
  return selectedStopwords;
}

/**
 * Normalizes input string (lowercase, strips accents, removes punctuation).
 */
export function cleanText(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^a-z0-9\s]/g, ' ')   // Retain alphanumeric and spaces
    .replace(/\s+/g, ' ')           // Collapse spaces
    .trim();
}

/**
 * Stems plural suffixes to improve word matching accuracy.
 */
export function removePluralSuffix(token) {
  if (token.length > 4 && token.endsWith('es')) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('s')) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Splits text into filtered, normalized tokens.
 */
export function generateTokens(text, stopwordsSet) {
  const cleaned = cleanText(text);
  if (!cleaned) return [];

  const tokens = [];
  const words = cleaned.split(' ');

  for (const word of words) {
    if (!word || word.length < 2) continue;
    const baseWord = removePluralSuffix(word);
    if (stopwordsSet.has(baseWord) || stopwordsSet.has(word)) continue;
    tokens.push(baseWord);
  }

  return tokens;
}

/**
 * Computes Jaccard Similarity between two sets.
 */
export function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const unionSize = setA.size + setB.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

/**
 * Counts the size of the intersection of two sets.
 */
function intersectionCount(setA, setB) {
  let count = 0;
  for (const token of setA) {
    if (setB.has(token)) count++;
  }
  return count;
}

/**
 * Implementation of Disjoint Set Union (Union-Find) for clustering.
 */
function createUnionFind(size) {
  const parent = Array.from({ length: size }, (_, idx) => idx);
  const rank = new Array(size).fill(0);

  function find(element) {
    let root = element;
    while (root !== parent[root]) {
      root = parent[root];
    }
    // Path compression
    let curr = element;
    while (curr !== root) {
      const next = parent[curr];
      parent[curr] = root;
      curr = next;
    }
    return root;
  }

  function union(elementA, elementB) {
    const rootA = find(elementA);
    const rootB = find(elementB);
    if (rootA === rootB) return false;

    if (rank[rootA] < rank[rootB]) {
      parent[rootA] = rootB;
    } else if (rank[rootA] > rank[rootB]) {
      parent[rootB] = rootA;
    } else {
      parent[rootB] = rootA;
      rank[rootA]++;
    }
    return true;
  }

  return { find, union };
}

/**
 * Selects the label for the cluster based on search volume and length.
 */
function selectClusterLabel(clusterMembers, tokenSets, sharedTokens) {
  // Try to find members that contain all shared tokens first
  const containingAllShared = clusterMembers.filter(member => {
    const tokens = tokenSets.get(member.keyword_id);
    return sharedTokens.every(t => tokens.has(t));
  });

  const candidates = containingAllShared.length > 0 ? containingAllShared : clusterMembers;

  // Sort by searches (descending), then keyword length (ascending)
  candidates.sort((a, b) => {
    const searchA = a.searches || 0;
    const searchB = b.searches || 0;
    if (searchA !== searchB) return searchB - searchA;
    return (a.keyword || '').length - (b.keyword || '').length;
  });

  return candidates[0].keyword;
}

/**
 * Decomposes oversized clusters into smaller sub-clusters using greedy similarity.
 */
function decomposeLargeCluster(memberIndices, tokenSets, idToKeywordMap, maxLimit, similarityThreshold) {
  const unassigned = new Set(memberIndices);
  const partitions = [];

  while (unassigned.size > 0) {
    if (unassigned.size <= maxLimit) {
      partitions.push(Array.from(unassigned));
      break;
    }

    // Select seed keyword as the one with the highest searches
    let seedIdx = null;
    let maxSearches = -1;
    for (const idx of unassigned) {
      const kw = idToKeywordMap.get(idx);
      const searchVolume = kw.searches || 0;
      if (searchVolume > maxSearches) {
        maxSearches = searchVolume;
        seedIdx = idx;
      }
    }

    const currentPartition = [seedIdx];
    unassigned.delete(seedIdx);

    // Greedily pull similar keywords
    while (currentPartition.length < maxLimit && unassigned.size > 0) {
      let bestIdx = null;
      let highestAverageSim = -1;

      for (const candidateIdx of unassigned) {
        const candidateSet = tokenSets.get(idToKeywordMap.get(candidateIdx).keyword_id);
        let similaritySum = 0;

        for (const memberIdx of currentPartition) {
          const memberSet = tokenSets.get(idToKeywordMap.get(memberIdx).keyword_id);
          similaritySum += jaccardSimilarity(candidateSet, memberSet);
        }

        const averageSim = similaritySum / currentPartition.length;
        if (averageSim > highestAverageSim) {
          highestAverageSim = averageSim;
          bestIdx = candidateIdx;
        }
      }

      if (highestAverageSim < similarityThreshold) {
        break; // Stop adding if similarity is below the threshold
      }

      currentPartition.push(bestIdx);
      unassigned.delete(bestIdx);
    }

    partitions.push(currentPartition);
  }

  return partitions;
}

/**
 * Main entry point for grouping keywords into topical concepts.
 */
export function clusterKeywordsIntoConcepts(keywordsList, config = {}) {
  const minSharedTokens = Number(config.cluster_min_shared_tokens ?? 2);
  const jaccardThreshold = Number(config.cluster_jaccard_threshold ?? 0.5);
  const useTagGraph = Number(config.cluster_use_tag_graph ?? 1) === 1;
  const maxClusterSize = Number(config.cluster_max_size ?? 8);
  const stopwords = resolveStopwords(config.cluster_stopword_langs ?? 'en,es');

  const count = keywordsList.length;
  if (count === 0) return [];

  const tokenSets = new Map();
  const tagSets = new Map();
  const indexToKeyword = new Map();

  // Initialize data structures
  for (let idx = 0; idx < count; idx++) {
    const item = keywordsList[idx];
    indexToKeyword.set(idx, item);
    tokenSets.set(item.keyword_id, new Set(generateTokens(item.keyword, stopwords)));

    const normalizedTags = Array.isArray(item.tags)
      ? item.tags.map(tag => cleanText(tag)).filter(Boolean).map(removePluralSuffix)
      : [];
    tagSets.set(item.keyword_id, new Set(normalizedTags));
  }

  const disjointSet = createUnionFind(count);

  // First pass: group by keyword token similarity
  for (let idxA = 0; idxA < count; idxA++) {
    const setA = tokenSets.get(keywordsList[idxA].keyword_id);
    if (setA.size === 0) continue;

    for (let idxB = idxA + 1; idxB < count; idxB++) {
      const setB = tokenSets.get(keywordsList[idxB].keyword_id);
      if (setB.size === 0) continue;

      if (intersectionCount(setA, setB) >= minSharedTokens) {
        if (jaccardSimilarity(setA, setB) >= jaccardThreshold) {
          disjointSet.union(idxA, idxB);
        }
      }
    }
  }

  // Second pass: group by tag graph co-occurrence if enabled
  if (useTagGraph) {
    for (let idxA = 0; idxA < count; idxA++) {
      const tagsA = tagSets.get(keywordsList[idxA].keyword_id);
      if (tagsA.size < 2) continue;

      for (let idxB = idxA + 1; idxB < count; idxB++) {
        if (disjointSet.find(idxA) === disjointSet.find(idxB)) continue;

        const tagsB = tagSets.get(keywordsList[idxB].keyword_id);
        if (tagsB.size < 2) continue;

        if (intersectionCount(tagsA, tagsB) >= 2) {
          disjointSet.union(idxA, idxB);
        }
      }
    }
  }

  // Aggregate into structural groups
  const groups = new Map();
  for (let idx = 0; idx < count; idx++) {
    const parentRoot = disjointSet.find(idx);
    if (!groups.has(parentRoot)) {
      groups.set(parentRoot, []);
    }
    groups.get(parentRoot).push(idx);
  }

  const finalizedConcepts = [];

  for (const indices of groups.values()) {
    const subPartitions = indices.length > maxClusterSize
      ? decomposeLargeCluster(indices, tokenSets, indexToKeyword, maxClusterSize, jaccardThreshold)
      : [indices];

    for (const partition of subPartitions) {
      const members = partition.map(idx => indexToKeyword.get(idx));
      
      // Calculate intersection of tokens across all members
      let intersectionSet = null;
      for (const m of members) {
        const tokens = tokenSets.get(m.keyword_id);
        if (intersectionSet === null) {
          intersectionSet = new Set(tokens);
        } else {
          for (const token of Array.from(intersectionSet)) {
            if (!tokens.has(token)) {
              intersectionSet.delete(token);
            }
          }
        }
      }

      const sharedTokensArr = Array.from(intersectionSet || []);
      const clusterLabel = selectClusterLabel(members, tokenSets, sharedTokensArr);
      const sumSearches = members.reduce((sum, m) => sum + (m.searches || 0), 0);

      finalizedConcepts.push({
        concept_label: clusterLabel,
        keyword_ids: members.map(m => m.keyword_id),
        keyword_count: members.length,
        total_searches: sumSearches,
        shared_tokens: sharedTokensArr
      });
    }
  }

  // Sort final concepts by total search volume in descending order
  finalizedConcepts.sort((a, b) => b.total_searches - a.total_searches);

  return finalizedConcepts;
}
