# Spotify Analytics Platform

Домашня робота з MongoDB на основі Spotify Tracks Dataset. 

Дані спочатку завантажуються у raw-колекцію, після чого перетворюються Aggregation Pipeline у документну модель, придатну для аналітичних запитів.

## Dataset

Використано **Spotify Tracks Dataset** з Kaggle:

`maharshipandya/-spotify-tracks-dataset`

Після завантаження та трансформації колекція `tracks` містить **113 999** документів.

## Структура проєкту

```text
.
├── scripts
│   ├── 01_load_data.py
│   └── 02_transform.js
├── queries
│    ├── part2_queries.js
│    └── part3_indexes.js
├── .env.example
├── .gitignore
├── README.md
└── requirements.txt
```

## Середовище

Для роботи використано:

- Python 3
- MongoDB Atlas
- `mongosh`
- залежності з `requirements.txt`

MongoDB Atlas використовується як віддалений MongoDB Replica Set, тому окреме локальне розгортання MongoDB або Docker не потрібне.

## Налаштування

Створити віртуальне середовище та встановити залежності:

```bash
python -m venv .venv
```

Windows:

```bash
.venv\Scripts\activate
pip install -r requirements.txt
```

Скопіювати `.env.example` у `.env` і заповнити параметри підключення до MongoDB Atlas відповідно до шаблону.

## Запуск

Спочатку завантажуються raw-дані:

```bash
python scripts/01_load_data.py
```

Після цього потрібно підключитися до Atlas через `mongosh` і послідовно виконати:

```bash
mongosh "ВАШ_URI" --file scripts/02_transform.js
mongosh "ВАШ_URI" --file scripts/part2_queries.js > scripts/part2_queries.out.js
mongosh "ВАШ_URI" --file scripts/part3_indexes.js > scripts/part3_indexes.out.js
```

`part3_indexes.js` є самодостатнім експериментом: на початку він видаляє всі користувацькі індекси, фіксує baseline, перевіряє candidate-індекси, видаляє їх, створює фінальні індекси та повторює `explain("executionStats")`.

---

# Частина 1 — Завантаження даних та проєктування схеми

## 1.1. Завантаження сирих даних

`01_load_data.py` завантажує вихідний CSV з Kaggle та заносить дані у колекцію `tracks_raw`.

На цьому етапі структура даних залишається близькою до вихідного CSV. Основна перебудова виконується окремо в MongoDB.

## 1.2. Трансформація схеми через Aggregation Pipeline

`scripts/02_transform.js` створює колекцію `tracks` за допомогою Aggregation Pipeline.

Під час трансформації:

- рядок з виконавцями перетворюється на масив `artists`;
- audio characteristics об'єднуються у вкладений документ `audio_features`;
- додається `duration_sec`;
- додається `popularity_tier`;
- технічні поля raw-рівня більше не переносяться у фінальний документ.

Приклад документа:

```javascript
{
  _id: ObjectId("..."),
  track_id: "5SuOikwiRyPMVoIQDJUgSV",
  album_name: "Comedy",
  track_name: "Comedy",
  popularity: 73,
  duration_ms: 230666,
  explicit: false,
  track_genre: "acoustic",
  artists: ["Gen Hoshino"],
  audio_features: {
    danceability: 0.676,
    energy: 0.461,
    loudness: -6.746,
    speechiness: 0.143,
    acousticness: 0.0322,
    instrumentalness: 0.00000101,
    liveness: 0.358,
    valence: 0.715,
    tempo: 87.917,
    key: 1,
    mode: 0,
    time_signature: 4
  },
  duration_sec: 230.7,
  popularity_tier: "high"
}
```

## Чому `audio_features` **вкладений документ**

`danceability`, `energy`, `tempo`, `loudness`, `speechiness` та інші поля описують одну логічну групу характеристик треку. У вкладеному документі вони не змішуються з ідентифікаторами, назвою, жанром та іншими основними властивостями треку.

Для цієї моделі це робить структуру документа зрозумілішою і дозволяє працювати з `audio_features` як з окремим логічним блоком.

Вкладеність не заважає індексації окремих характеристик. MongoDB дозволяє створювати індекси, наприклад, на:

```text
audio_features.tempo
audio_features.danceability
audio_features.instrumentalness
```

У Частині 3 це використовується безпосередньо в кількох compound indexes.

Недолік такого підходу проявився б, якби audio features мали незалежний життєвий цикл або часто оновлювалися окремо від треку. Для цього набору даних вони є властивостями самого треку, тому вкладена модель виглядає природно.

## Чому `artists` **масив**

Один трек може мати одного або кількох виконавців, тому `artists` зберігається як масив, а не як рядок із роздільниками.

Це дозволяє:

- шукати треки конкретного виконавця без ручного розбору рядка;
- використовувати array operators MongoDB;
- використовувати `$unwind` для статистики по окремих виконавцях;
- природно представляти collaboration-треки.

Саме `$unwind: "$artists"` використовується у другому аналітичному запиті.

---

# Частина 2 — Запити до даних

## 2.1. Треки для вечірки

Вибираються треки з такими умовами:

```text
danceability > 0.7
energy > 0.7
180000 <= duration_ms <= 300000
```

Отримано **7 311** документів.

Запит добре підходить для compound index, оскільки всі умови застосовуються безпосередньо до полів документа.

## 2.2. Виконавці, у яких усі треки популярні

Потрібно знайти виконавців, у яких:

- не менше трьох треків;
- мінімальна popularity усіх їхніх треків не менше 60.

У вихідному наборі один `track_id` може повторюватися в кількох жанрових рядках. Якщо одразу групувати після `$unwind`, один і той самий трек може бути порахований кілька разів.

Тому pipeline спочатку робить дедуплікацію за:

```text
artist + track_id
```

і лише після цього рахує статистику по виконавцю.

Для дубльованого `track_id` використовується мінімальна popularity. Це консервативний варіант: якщо одна з копій має нижчу popularity, вона не буде прихована під час перевірки умови `min_popularity >= 60`.

Після фільтрації та сортування повертаються top 20 виконавців.

## 2.3. Нетипові треки

Для кожного жанру обчислюються:

```text
avg_tempo
stddev_tempo
outlier_threshold = avg_tempo + 2 * stddev_tempo
```

Після цього `$lookup` знаходить треки того самого жанру, у яких:

```text
tempo > outlier_threshold
```

Отримано **112** жанрів, у яких є tempo outliers.

Цей pipeline виявився найцікавішим з точки зору оптимізації: без індексу вкладений `$lookup` повторно сканував всю колекцію для кожного жанру.

## 2.4. Треки для фонової роботи

Умови:

```text
loudness < -10
speechiness < 0.1
instrumentalness > 0.5
explicit = false
```

Отримано **9 324** треки.

---

# Частина 3 — Індекси та оптимізація

## Методика вимірювання

Для порівняння продуктивності використовується:

```javascript
explain("executionStats")
```

Основні метрики:

- `COLLSCAN` / `IXSCAN`;
- `FETCH`;
- `SORT`;
- `PROJECTION_COVERED`;
- `totalDocsExamined`;
- `totalKeysExamined`;
- `collectionScans`;
- `indexesUsed`;
- `executionTimeMillis`.

### Чому не використовується клієнтський timing

Час навколо `toArray()` через `Date.now()` не використовується для оцінки ефективності індексів.

MongoDB Atlas працює віддалено, тому такий час включає не тільки виконання запиту на сервері, а й:

- мережеву затримку;
- передачу результатів з Atlas;
- нестабільність поточного інтернет-з'єднання;
- розмір result set;
- BSON/JavaScript processing у `mongosh`.

Під час роботи частина тестів виконувалася через нестабільне мобільне 3G-з'єднання, тому client-side timing міг змінюватися в рази незалежно від реальної вартості виконання запиту в MongoDB.

Через це основою порівняння є серверні `executionStats`, а `executionTimeMillis` розглядається разом зі структурними метриками, а не окремо.

---

## Baseline

Перед вимірюванням:

```javascript
db.tracks.dropIndexes()
```

Після цього в колекції залишається тільки стандартний `_id_` index.

## 3.1. Аналіз запиту та індексація

### Запит:

```javascript
db.tracks.find({
  track_genre: "pop",
  "audio_features.danceability": { $gte: 0.7 }
}).sort({ popularity: -1 })
```

### Baseline:

```text
SORT
COLLSCAN

nReturned: 354
totalDocsExamined: 113999
totalKeysExamined: 0
executionTimeMillis: 74
```

MongoDB читає всю колекцію, а потім окремо сортує результат.

### Candidate index

Перший варіант:

```javascript
{
  track_genre: 1,
  "audio_features.danceability": 1,
  popularity: -1
}
```

Результат:

```text
FETCH
SORT
IXSCAN

nReturned: 354
totalDocsExamined: 354
totalKeysExamined: 354
executionTimeMillis: 2
```

Індекс дуже добре звузив вибірку, але через range по `danceability` перед `popularity` MongoDB все одно виконує окремий `SORT`.

### Фінальний index

```javascript
{
  track_genre: 1,
  popularity: -1,
  "audio_features.danceability": 1
}
```

Результат:

```text
FETCH
IXSCAN

nReturned: 354
totalDocsExamined: 354
totalKeysExamined: 412
executionTimeMillis: 7
```

MongoDB переглянула трохи більше index keys — `412` замість `354`, але окрема стадія `SORT` зникла.

Одиничний `executionTimeMillis` у candidate-варіанта вийшов меншим, тому вибір фінального індексу не базується на різниці `2 ms` проти `7 ms`. Важливіша відмінність у самому execution plan: фінальний ESR-порядок обслуговує і фільтрацію за жанром, і потрібний порядок `popularity` без окремого сортування.

Фінальний індекс:

```javascript
idx_genre_popularity_danceability
```

---

## 3.2. Індекс для інших полів

### Baseline:

```text
instrumentalness > 0.5
speechiness < 0.1
explicit = false
```

```text
COLLSCAN

nReturned: 16141
totalDocsExamined: 113999
totalKeysExamined: 0
executionTimeMillis: 125
```

### Candidate index:

```javascript
{
  explicit: 1,
  "audio_features.instrumentalness": 1,
  "audio_features.speechiness": 1
}
```

Результат:

```text
FETCH
IXSCAN

nReturned: 16141
totalDocsExamined: 16141
totalKeysExamined: 16602
executionTimeMillis: 36
```

Candidate index уже добре відпрацьовує для обов'язкового запиту 3.2, однак реальний запит з 2.4 має ще одну умову:

```text
loudness < -10
```

З candidate index для 2.4:

```text
nReturned: 9324
totalDocsExamined: 16141
totalKeysExamined: 16602
```

Після додавання `loudness` до compound index:

```javascript
{
  explicit: 1,
  "audio_features.instrumentalness": 1,
  "audio_features.speechiness": 1,
  "audio_features.loudness": 1
}
```

отримуємо для 2.4:

```text
FETCH
IXSCAN

nReturned: 9324
totalDocsExamined: 9324
totalKeysExamined: 15417
executionTimeMillis: 36
```

Тобто MongoDB більше не читає документи, які потім відкидаються через `loudness`.

При цьому той самий чотирипольовий індекс продовжує обслуговувати обов'язковий запит 3.2 через свій prefix.

Тому коротший candidate index був видалений як redundant, а фінальним залишено:

```javascript
idx_background_work
```

---

## 3.3. Покривний запит (факультативне — не оцінюється)

### Запит:

```javascript
db.tracks.find({
  track_genre: "pop",
  popularity: { $gte: 70 }
})
```

використовує `idx_genre_popularity_danceability`, але повертає повний документ.

```text
FETCH
IXSCAN

nReturned: 317
totalDocsExamined: 317
totalKeysExamined: 317
```

Індекс використовується для пошуку, але MongoDB все одно повинна прочитати 317 документів.

### Covered-варіант:

```javascript
db.tracks.find(
  {
    track_genre: "pop",
    popularity: { $gte: 70 }
  },
  {
    _id: 0,
    track_genre: 1,
    popularity: 1
  }
)
```

```text
PROJECTION_COVERED
IXSCAN

nReturned: 317
totalDocsExamined: 0
totalKeysExamined: 317
```

Усі поля filter і projection присутні в одному індексі, а `_id` явно виключений. MongoDB отримує весь результат без читання документів колекції.

Тобто наявність індексу сама по собі не робить запит covered. Потрібна комбінація:

```text
filter + projection + index
```

---

# Додаткова оптимізація запитів Частини 2

Після оптимізації схеми вирішив пройтись до завданням Частини 2 і подивитись, що можна додатково оптимізувати

## 2.1. Треки для вечірки

### Baseline:

```text
COLLSCAN

nReturned: 7311
totalDocsExamined: 113999
totalKeysExamined: 0
executionTimeMillis: 102
```

### Фінальний індекс:

```javascript
{
  "audio_features.danceability": 1,
  "audio_features.energy": 1,
  duration_ms: 1
}
```

```text
FETCH
IXSCAN

nReturned: 7311
totalDocsExamined: 7311
totalKeysExamined: 11278
executionTimeMillis: 27
```

Після індексації MongoDB читає рівно стільки документів, скільки повертає в результаті.

Фінальний індекс:

```javascript
idx_party_tracks
```

---

## 2.2. Виконавці, у яких усі треки популярні

До індексів:

```text
PROJECTION_SIMPLE
COLLSCAN

totalDocsExamined: 113999
executionTimeMillis: 847
```

Після створення всіх фінальних індексів:

```text
PROJECTION_SIMPLE
COLLSCAN

totalDocsExamined: 113999
executionTimeMillis: 838
```

План практично не змінився.

Причина в структурі pipeline:

```text
113999 documents
    ↓
$unwind
158292
    ↓
$group by artist + track_id
123424
    ↓
$group by artist
29858
    ↓
$match
170
    ↓
$sort / $limit
20
```

Немає раннього selective `$match`, який дозволив би індексу відкинути значну частину колекції до `$unwind` і `$group`.

Тому окремий індекс для цього pipeline не створювався. Це також практичний результат оптимізації: не кожен aggregation pipeline можна прискорити додаванням індексу.

---

## 2.3. Нетипові треки

!!! Це найбільша зміна в усьому експерименті.

Без індексу початковий `$group` формує 114 жанрів, після чого `$lookup` повторно шукає outliers у `tracks`.

### Baseline `$lookup`:

```text
nReturned: 114
totalDocsExamined: 12995886
totalKeysExamined: 0
collectionScans: 114
indexesUsed: []
executionTimeMillisEstimate: 11726
```

`12 995 886` переглянутих документів практично відповідає повному проходу по `113 999` документах для кожного зі 114 жанрів.

### Фінальний індекс:

```javascript
{
  track_genre: 1,
  "audio_features.tempo": 1
}
```

підтримує умови всередині `$lookup`:

```text
track_genre = genre
tempo > threshold
```

### Після індексації:

```text
nReturned: 114
totalDocsExamined: 3506
totalKeysExamined: 3506
collectionScans: 0
indexesUsed: ["idx_genre_tempo"]
executionTimeMillisEstimate: 195
```

Початковий `$group` все одно читає всю колекцію, тому top-level plan залишається повним scan для першої фази. Але найдорожча частина pipeline — повторні сканування всередині `$lookup` — повністю зникає.

Фінальний індекс:

```javascript
idx_genre_tempo
```

---

## 2.4: Треки для фонової роботи

## Baseline:

```text
COLLSCAN

nReturned: 9324
totalDocsExamined: 113999
totalKeysExamined: 0
executionTimeMillis: 114
```

## Після `idx_background_work`:

```text
FETCH
IXSCAN

nReturned: 9324
totalDocsExamined: 9324
totalKeysExamined: 15417
executionTimeMillis: 36
```

MongoDB читає тільки документи, які реально потрапляють у результат.

---

# Фінальні індекси

Після всіх експериментів у колекції залишено чотири користувацькі індекси.

## `idx_genre_popularity_danceability`

```javascript
{
  track_genre: 1,
  popularity: -1,
  "audio_features.danceability": 1
}
```

Використовується в 3.1 і 3.3.

## `idx_background_work`

```javascript
{
  explicit: 1,
  "audio_features.instrumentalness": 1,
  "audio_features.speechiness": 1,
  "audio_features.loudness": 1
}
```

Підтримує 3.2 та повний Background work query з Частини 2.

## `idx_genre_tempo`

```javascript
{
  track_genre: 1,
  "audio_features.tempo": 1
}
```

Прибирає повторні collection scans із `$lookup` у Tempo outliers.

## `idx_party_tracks`

```javascript
{
  "audio_features.danceability": 1,
  "audio_features.energy": 1,
  duration_ms: 1
}
```

Підтримує запити 2.1.

---

# Підсумок

Найбільший ефект індексації видно не за одиничним часом виконання, а за кількістю роботи, яку MongoDB більше не виконує.

Основні результати:

| Запит | До індексів | Після індексів |
|-------|---:|---:|
| 3.1   | 113 999 docs + `SORT` | 354 docs, без окремого `SORT` |
| 3.2   | 113 999 docs | 16 141 docs |
| 3.3   | 317 docs | 0 docs |
| 2.1   | 113 999 docs | 7 311 docs |
| 2.3   | 12 995 886 docs, 114 scans | 3 506 docs, 0 scans |
| 2.4   | 113 999 docs | 9 324 docs |

Окремо показовим виявився 2.2: наявні індекси не змінили його план, оскільки до `$unwind` і глобальних `$group` немає selective filter. Тому індекс не додавався лише заради формальної оптимізації.

У підсумку індекси залишено тільки там, де `executionStats` показує реальне скорочення роботи MongoDB або покращення execution plan.
