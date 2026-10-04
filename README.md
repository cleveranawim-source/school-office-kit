# AI 교무실 만들기 키트

**[시작 안내서](https://cleveranawim-source.github.io/school-office-kit/)** · **[3분 소개 영상](https://cleveranawim-source.github.io/school-office-kit/intro.mp4)** · 질문은 [Discussions](https://github.com/cleveranawim-source/school-office-kit/discussions)

선생님이 **Claude Code** 또는 **Codex**와 함께, 우리 학교 교직원용 사이트(「AI 교무실」)를 처음부터 만들 수 있게 돕는 안내 묶음입니다.

한 중학교(이하 「원본 학교」)가 2026년 9월부터 실제로 만들어 운영 중인 교직원 사이트에서 뽑았습니다. 그 학교의 코드를 그대로 옮기는 것이 아니라, 다음 세 가지를 건넵니다.

1. **무엇을 만들까** — 모듈 카탈로그. 모듈마다 어떤 불편을 덜어 주는지, 무엇이 먼저 있어야 하는지, 얼마나 어려운지.
2. **어떻게 만들까** — 뼈대 설계와 구축 순서. 단계마다 넘어가기 전에 확인할 관문.
3. **무엇을 조심할까** — 함정 노트와 보안 기준선. 직접 부딪쳐 알게 된 것들.

학교마다 쓰는 시스템(보건실 프로그램, 학부모 창구, 칠판 PC, 시간표 파일 형식)이 다르기 때문에, 첫 대화에서 에이전트가 우리 학교 사정을 묻고(인터뷰) 그에 맞는 순서를 짭니다.

## 이런 분께 맞습니다

- Claude Code나 Codex를 한 번 이상 써 본 선생님
- 교직원 30~100명 규모 학교에서, 공지·시간표·자료실·업무 요청 같은 일을 한곳에 모으고 싶은 분
- 학교 관리자(교감·정보부장)와 사이트 운영을 미리 이야기할 수 있는 분

개발 경험은 없어도 됩니다. 다만 **교직원 개인정보를 다루는 사이트**이므로, 보안 기준선(`kit/docs/05-보안기준선.md`)의 관문은 건너뛰지 않습니다.

## 시작하기

1. 이 저장소를 내 계정으로 복제합니다(GitHub에서 「Use this template」 또는 `git clone`).
2. 폴더를 연 상태에서 에이전트를 실행합니다.
   - Claude Code: 폴더에서 `claude`
   - Codex: 폴더에서 `codex`
3. 이렇게 말합니다: **「우리 학교 교무실 만들기 시작하자」**

에이전트가 `AGENTS.md`와 진행 스킬(`school-office`)을 읽고 인터뷰부터 시작합니다.

중간에 이렇게 말해도 됩니다: 「다음 단계 하자」 · 「관문 검사해 줘」 · 「지금 어디까지 했어?」 · 「결석 접수도 만들고 싶어」.

관문 검사는 직접 돌려 볼 수도 있습니다.

```bash
node .agents/skills/school-office/scripts/gate.mjs
``` 인터뷰가 끝나면 `school-profile.md`(우리 학교 정보)와 `progress.md`(구축 기록)가 생기고, 다음 대화부터는 그 기록을 이어서 진행합니다.

## 준비물

`kit/docs/00-준비물.md`에 자세히 있습니다. 요약하면:

- GitHub 계정, Supabase 계정(데이터베이스·로그인), Vercel 계정(사이트 배포)
- AI 도우미를 붙일 경우 AI 회사 API 키(학교 예산으로 결제할지 미리 정하기)
- 컴퓨터에 Node.js
- 학교 관리자와 합의: 누구 명의 계정으로 운영할지, 내가 전근 가면 누가 이어받을지

## 폴더 안내

| 경로 | 내용 |
|---|---|
| `AGENTS.md` | 에이전트가 읽는 작업 규칙 (Codex·Claude Code 공통) |
| `CLAUDE.md` | Claude Code용 — `AGENTS.md`를 불러옵니다 |
| `.agents/skills/school-office/` | 진행 스킬 정본(Codex). 인터뷰·계획·설계 메모·관문 검사 |
| `.claude/skills/school-office/` | 같은 스킬의 Claude Code용 사본(`kit/scripts/sync-skills.mjs`로 맞춤) |
| `kit/docs/` | 키트 문서 (사람도 읽을 수 있게 썼습니다) |
| `kit/templates/` | 인터뷰 결과·구축 기록 양식 |
| `school-profile.md` | (인터뷰 뒤 생김) 우리 학교 정보 |
| `progress.md` | (인터뷰 뒤 생김) 단계별 구축 기록 |

## 출처와 범위

- 원본: 한 중학교가 운영 중인 「AI 교무실」 (Next.js + Supabase + Vercel, 2026-09 ~)
- 이 키트에는 원본 학교의 교직원·학생 정보, 비밀 값, 서식 원본이 들어 있지 않습니다.
- 라이선스: MIT (`LICENSE`). 자유롭게 고쳐 쓰고 나눠도 됩니다.
- 키트를 고쳐 쓰다 알게 된 함정이 있으면 Discussions에 나눠 주세요. 다음 학교가 덜 헤맵니다.
