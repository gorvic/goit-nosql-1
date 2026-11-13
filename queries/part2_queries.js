db = db.getSiblingDB("spotify");


//####################################################
// Task 1. Party tracks
//####################################################

print("# Task 1. Party tracks\n");

const partyFilter = {
    "audio_features.danceability": { $gt: 0.7 },
    "audio_features.energy": { $gt: 0.7 },
    duration_ms: { $gte: 180000, $lte: 300000 }
};

const partyTracks = db.tracks.find(
    partyFilter,
    {
        _id: 0,
        track_id: 1,
        track_name: 1,
        artists: 1,
        popularity: 1,
        duration_ms: 1,
        "audio_features.danceability": 1,
        "audio_features.energy": 1
    }
).toArray();

print(`Found tracks: ${partyTracks.length}`);
partyTracks.slice(0, 10).forEach((track) => printjson(track));


//####################################################
// Task 2. Artists with only popular tracks
//####################################################

print("\n\n# Task 2. Artists with only popular tracks\n");

const popularArtistsPipeline = [
    {
        $unwind: "$artists"
    },
    {
        // The same track_id can appear in several genre rows in the source data.
        // Deduplicate by artist + track_id before calculating artist statistics.
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

const popularArtists = db.tracks.aggregate(popularArtistsPipeline).toArray();

print(`Found artists: ${popularArtists.length}`);
popularArtists.forEach((artist) => printjson(artist));


//####################################################
// Task 3. Tempo outliers by genre
//####################################################

print("\n\n# Task 3. Tempo outliers by genre\n");

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

const tempoOutliers = db.tracks.aggregate(tempoOutliersPipeline).toArray();

print(`Found genres with outliers: ${tempoOutliers.length}`);
tempoOutliers.slice(0, 5).forEach((genre) => printjson(genre));


//####################################################
// Task 4. Background work tracks
//####################################################

print("\n\n# Task 4. Background work tracks\n");

const backgroundFilter = {
    "audio_features.loudness": { $lt: -10 },
    "audio_features.speechiness": { $lt: 0.1 },
    "audio_features.instrumentalness": { $gt: 0.5 },
    explicit: false
};

const backgroundTracks = db.tracks.find(
    backgroundFilter,
    {
        _id: 0,
        track_id: 1,
        track_name: 1,
        popularity: 1,
        explicit: 1,
        artists: 1,
        "audio_features.loudness": 1,
        "audio_features.speechiness": 1,
        "audio_features.instrumentalness": 1
    }
).toArray();

print(`Found tracks: ${backgroundTracks.length}`);
backgroundTracks.slice(0, 10).forEach((track) => printjson(track));
