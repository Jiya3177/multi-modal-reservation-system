# StudyGenie API Examples

Base URL: `http://localhost:8000/api`

## Signup

```bash
curl -X POST http://localhost:8000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "Ava Student",
    "email": "ava@example.com",
    "password": "study1234"
  }'
```

## Login

```bash
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "ava@example.com",
    "password": "study1234"
  }'
```

## Upload Text Notes

```bash
curl -X POST http://localhost:8000/api/upload-text \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "title": "Biology Notes",
    "content": "Photosynthesis happens in chloroplasts..."
  }'
```

## Upload PDF

```bash
curl -X POST http://localhost:8000/api/upload-document \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "file=@/absolute/path/to/notes.pdf"
```

## Upload Image

```bash
curl -X POST http://localhost:8000/api/upload-image \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "file=@/absolute/path/to/notes.png"
```

## Add Website Link

```bash
curl -X POST http://localhost:8000/api/add-link \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "title": "Physics Article",
    "url": "https://example.com/physics"
  }'
```

## Generate Summary

```bash
curl -X POST http://localhost:8000/api/generate-summary \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "material_id": 1
  }'
```

## Edit Summary

```bash
curl -X POST http://localhost:8000/api/edit-summary \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "summary_id": 1,
    "edited_text": "• Updated notes here"
  }'
```

## Download Summary PDF

```bash
curl -L http://localhost:8000/api/download-summary-pdf/1 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  --output studygenie-summary.pdf
```

## Ask Question

```bash
curl -X POST http://localhost:8000/api/ask-question \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "material_id": 1,
    "question": "Explain photosynthesis in simple terms."
  }'
```

## Generate Flashcards

```bash
curl -X POST http://localhost:8000/api/generate-flashcards \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "material_id": 1
  }'
```

## Generate Quiz

```bash
curl -X POST http://localhost:8000/api/generate-quiz \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "material_id": 1,
    "question_count": 5
  }'
```

## Submit Quiz

```bash
curl -X POST http://localhost:8000/api/submit-quiz \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "material_id": 1,
    "answers": [
      { "question_id": 1, "user_answer": "B" },
      { "question_id": 2, "user_answer": "True" }
    ]
  }'
```

## Generate Study Plan

```bash
curl -X POST http://localhost:8000/api/generate-study-plan \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "title": "Midterm Plan",
    "exam_date": "2026-05-20",
    "subjects": ["Physics", "Math"],
    "study_hours_per_day": 3
  }'
```

## Get Performance

```bash
curl http://localhost:8000/api/get-performance \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```
