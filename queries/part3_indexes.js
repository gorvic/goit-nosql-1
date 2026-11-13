db = db.getSiblingDB("spotify");

//####################################################
// Helpers
//####################################################

function collectPlanStages(node, stages = [], indexNames = []) {
    if (!node || typeof node !== "object") {
        return { stages, indexNames };
    }

    if (node.stage && !stages.includes(node.stage)) {
        stages.push(node.stage);
    }

    if (node.indexName && !indexNames.includes(node.indexName)) {
        indexNames.push(node.indexName);
    }

    for (const value of Object.values(node)) {
        if (value && typeof value === "object") {
            collectPlanStages(value, stages, indexNames);
        }
    }

    return { stages, indexNames };
}


function getExecutionStats(explain) {
    if (explain.executionStats) {
        return explain.executionStats;
    }

    if (Array.isArray(explain.stages)) {
        const cursorStage = explain.stages.find((stage) => stage.$cursor);

        if (cursorStage && cursorStage.$cursor.executionStats) {
            return cursorStage.$cursor.executionStats;
        }
    }

    return null;
}


function printExplainSummary(title, explain) {
    print(`\n## ${title}`);

    const executionStats = getExecutionStats(explain);
    const planRoot = executionStats
        ? executionStats.executionStages
        : explain.queryPlanner?.winningPlan;

    const plan = collectPlanStages(planRoot);

    printjson({
        planStages: plan.stages,
        indexesUsed: plan.indexNames,
        nReturned: executionStats?.nReturned,
        executionTimeMillis: executionStats?.executionTimeMillis,
        totalDocsExamined: executionStats?.totalDocsExamined,
        totalKeysExamined: executionStats?.totalKeysExamined
    });

    if (!Array.isArray(explain.stages)) {
        return;
    }

    const pipelineStages = [];

    for (const stage of explain.stages) {
        const stageName = Object.keys(stage).find((key) => key.startsWith("$"));

        if (!stageName || stageName === "$cursor") {
            continue;
        }

        pipelineStages.push({
            stage: stageName,
            nReturned: stage.nReturned,
            executionTimeMillisEstimate: stage.executionTimeMillisEstimate,
            totalDocsExamined: stage.totalDocsExamined,
            totalKeysExamined: stage.totalKeysExamined,
            collectionScans: stage.collectionScans,
            indexesUsed: stage.indexesUsed
        });
    }

    if (pipelineStages.length > 0) {
        print("Pipeline stages:");
        printjson(pipelineStages);
    }
}


//####################################################
// Query definitions
//####################################################

const task31Filter = {
    track_genre: "pop",
    "audio_features.danceability": { $gte: 0.7 }
};

const task32Filter = {
    "audio_features.instrumentalness": { $gt: 0.5 },
    "audio_features.speechiness": { $lt: 0.1 },
    explicit: false
};

const partyFilter = {
    "audio_features.danceability": { $gt: 0.7 },
    "audio_features.energy": { $gt: 0.7 },
    duration_ms: { $gte: 180000, $lte: 300000 }
};

const backgroundFilter = {
    "audio_features.loudness": { $lt: -10 },
    "audio_features.speechiness": { $lt: 0.1 },
    "audio_features.instrumentalness": { $gt: 0.5 },
    explicit: false
};

const popularArtistsPipeline = [
    {
        $unwind: "$artists"
    },
    {
        $group: {
            _id: {
                artist: "$artists",
                track_id: "$track_id"
            },
            popularity: { $min: "$popularity" }
        }
    },
    {
        $group: {
            _id: "$_id.artist",
            track_count: { $sum: 1 },
            min_popularity: { $min: "$popularity" },
            avg_popularity: { $avg: "$popularity" }
        }
    },
    {
        $match: {
            track_count: { $gte: 3 },
            min_popularity: { $gte: 60 }
        }
    },
    {
        $project: {
            _id: 0,
            artist: "$_id",
            track_count: 1,
            min_popularity: 1,
            avg_popularity: { $round: ["$avg_popularity", 1] }
        }
    },
    {
        $sort: {
            avg_popularity: -1,
            track_count: -1,
            artist: 1
        }
    },
    {
        $limit: 20
    }
];

const tempoOutliersPipeline = [
    {
        $group: {
            _id: "$track_genre",
            avg_tempo: { $avg: "$audio_features.tempo" },
            stddev_tempo: { $stdDevPop: "$audio_features.tempo" }
        }
    },
    {
        $set: {
            outlier_threshold: {
                $add: [
                    "$avg_tempo",
                    { $multiply: [2, "$stddev_tempo"] }
                ]
            }
        }
    },
    {
        $lookup: {
            from: "tracks",
            let: {
                genre: "$_id",
                threshold: "$outlier_threshold"
            },
            pipeline: [
                {
                    $match: {
                        $expr: {
                            $and: [
                                { $eq: ["$track_genre", "$$genre"] },
                                {
                                    $gt: [
                                        "$audio_features.tempo",
                                        "$$threshold"
                                    ]
                                }
                            ]
                        }
                    }
                },
                {
                    $project: {
                        _id: 1,
                        track_name: 1,
                        popularity: 1,
                        artists: 1,
                        "audio_features.tempo": 1
                    }
                }
            ],
            as: "outlier_tracks"
        }
    },
    {
        $match: {
            "outlier_tracks.0": { $exists: true }
        }
    },
    {
        $project: {
            _id: 0,
            genre: "$_id",
            avg_tempo: { $round: ["$avg_tempo", 1] },
            outlier_threshold: { $round: ["$outlier_threshold", 1] },
            outlier_tracks: 1
        }
    },
    {
        $sort: {
            genre: 1
        }
    }
];


//####################################################
// 1. Clean start
//####################################################

// Reset custom indexes
db.tracks.dropIndexes();

print("# Initial indexes");
printjson(db.tracks.getIndexes());


//####################################################
// 2. Baseline: no custom indexes
//####################################################

print("\n\n# BASELINE: NO CUSTOM INDEXES");

const task31Before = db.tracks
    .explain("executionStats")
    .find(task31Filter)
    .sort({ popularity: -1 })
    .finish();

printExplainSummary(
    "Part 3 / Task 1 - BEFORE index",
    task31Before
);


const task32Before = db.tracks
    .explain("executionStats")
    .find(task32Filter)
    .finish();

printExplainSummary(
    "Part 3 / Task 2 - BEFORE index",
    task32Before
);


const partyBefore = db.tracks
    .explain("executionStats")
    .find(partyFilter)
    .finish();

printExplainSummary(
    "Part 2 / Task 1 - BEFORE indexes",
    partyBefore
);


const artistsBefore = db.tracks
    .explain("executionStats")
    .aggregate(popularArtistsPipeline);

printExplainSummary(
    "Part 2 / Task 2 - BEFORE indexes",
    artistsBefore
);


const tempoBefore = db.tracks
    .explain("executionStats")
    .aggregate(tempoOutliersPipeline);

printExplainSummary(
    "Part 2 / Task 3 - BEFORE indexes",
    tempoBefore
);


const backgroundBefore = db.tracks
    .explain("executionStats")
    .find(backgroundFilter)
    .finish();

printExplainSummary(
    "Part 2 / Task 4 - BEFORE indexes",
    backgroundBefore
);


//####################################################
// 3. Candidate indexes
//####################################################

print("\n\n# CANDIDATE INDEXES");

// Task 3.1 candidate: equality -> range -> sort.
// It filters slightly fewer index keys, but requires a separate SORT stage.
print("\nCandidate: genre -> danceability -> popularity");

db.tracks.createIndex(
    {
        track_genre: 1,
        "audio_features.danceability": 1,
        popularity: -1
    },
    {
        name: "idx_candidate_genre_danceability_popularity"
    }
);

const task31Candidate = db.tracks
    .explain("executionStats")
    .find(task31Filter)
    .sort({ popularity: -1 })
    .finish();

printExplainSummary(
    "Part 3 / Task 1 - CANDIDATE index",
    task31Candidate
);

db.tracks.dropIndex("idx_candidate_genre_danceability_popularity");


// Task 3.2 candidate: enough for the assignment query, but later superseded
// by the final background-work index that also includes loudness.
print("\nCandidate: explicit -> instrumentalness -> speechiness");

db.tracks.createIndex(
    {
        explicit: 1,
        "audio_features.instrumentalness": 1,
        "audio_features.speechiness": 1
    },
    {
        name: "idx_candidate_explicit_instrumentalness_speechiness"
    }
);

const task32Candidate = db.tracks
    .explain("executionStats")
    .find(task32Filter)
    .finish();

printExplainSummary(
    "Part 3 / Task 2 - CANDIDATE index",
    task32Candidate
);

const backgroundCandidate = db.tracks
    .explain("executionStats")
    .find(backgroundFilter)
    .finish();

printExplainSummary(
    "Part 2 / Task 4 - with CANDIDATE index",
    backgroundCandidate
);

db.tracks.dropIndex(
    "idx_candidate_explicit_instrumentalness_speechiness"
);


//####################################################
// 4. Final indexes
//####################################################

db.tracks.createIndex(
    {
        track_genre: 1,
        popularity: -1,
        "audio_features.danceability": 1
    },
    {
        name: "idx_genre_popularity_danceability"
    }
);

db.tracks.createIndex(
    {
        explicit: 1,
        "audio_features.instrumentalness": 1,
        "audio_features.speechiness": 1,
        "audio_features.loudness": 1
    },
    {
        name: "idx_background_work"
    }
);

db.tracks.createIndex(
    {
        track_genre: 1,
        "audio_features.tempo": 1
    },
    {
        name: "idx_genre_tempo"
    }
);

db.tracks.createIndex(
    {
        "audio_features.danceability": 1,
        "audio_features.energy": 1,
        duration_ms: 1
    },
    {
        name: "idx_party_tracks"
    }
);

print("\n\n# FINAL INDEXES");
printjson(db.tracks.getIndexes());

//####################################################
// 5. Final measurements
//####################################################

print("\n\n# FINAL EXPLAIN RESULTS#");

// Part 3 / Task 1
const task31After = db.tracks
    .explain("executionStats")
    .find(task31Filter)
    .sort({ popularity: -1 })
    .finish();

printExplainSummary(
    "Part 3 / Task 1 - FINAL index",
    task31After
);


// Part 3 / Task 2
const task32After = db.tracks
    .explain("executionStats")
    .find(task32Filter)
    .finish();

printExplainSummary(
    "Part 3 / Task 2 - FINAL index",
    task32After
);


// Part 3 / Task 3: original query.
// The filter can use the index, but full documents still require FETCH.
const task33Filter = {
    track_genre: "pop",
    popularity: { $gte: 70 }
};

const task33Original = db.tracks
    .explain("executionStats")
    .find(task33Filter)
    .finish();

printExplainSummary(
    "Part 3 / Task 3 - ORIGINAL query",
    task33Original
);


// Part 3 / Task 3: covered query.
// Only indexed fields are returned and _id is explicitly excluded.
const task33Covered = db.tracks
    .explain("executionStats")
    .find(
        task33Filter,
        {
            _id: 0,
            track_genre: 1,
            popularity: 1
        }
    )
    .finish();

printExplainSummary(
    "Part 3 / Task 3 - COVERED query",
    task33Covered
);


// Part 2 / Task 1
const partyAfter = db.tracks
    .explain("executionStats")
    .find(partyFilter)
    .finish();

printExplainSummary(
    "Part 2 / Task 1 - FINAL indexes",
    partyAfter
);


// Part 2 / Task 2.
// No early selective $match exists, so the pipeline still needs a full scan.
const artistsAfter = db.tracks
    .explain("executionStats")
    .aggregate(popularArtistsPipeline);

printExplainSummary(
    "Part 2 / Task 2 - FINAL indexes",
    artistsAfter
);


// Part 2 / Task 3
const tempoAfter = db.tracks
    .explain("executionStats")
    .aggregate(tempoOutliersPipeline);

printExplainSummary(
    "Part 2 / Task 3 - FINAL indexes",
    tempoAfter
);


// Part 2 / Task 4
const backgroundAfter = db.tracks
    .explain("executionStats")
    .find(backgroundFilter)
    .finish();

printExplainSummary(
    "Part 2 / Task 4 - FINAL indexes",
    backgroundAfter
);


//####################################################
// 6. Final state
//####################################################

print("\n# Final index state");
printjson(db.tracks.getIndexes());
