// Small, deployment-safe excerpts for the AI answer route. Keep private
// candidate history in AI_PROFILE_EVIDENCE; only include public project facts
// that can be verified from the linked repositories.
export const AI_PROJECT_EVIDENCE = [
  {
    source: 'GitHub: telecom-sql-analytics (public repository)',
    excerpt: 'The repository README documents a full-stack telecom churn analytics project using PostgreSQL and SQL, with a 7,043-row dataset, 33 attributes, 194 SQL queries/objects, 10 REST endpoints, and a six-page dashboard. It describes aggregations, window functions, CTEs, subqueries, views, indexes, procedures, tests, and business KPIs. Dataset findings are project analysis, not employer business results.',
  },
  {
    source: 'GitHub: ims_automation (public repository)',
    excerpt: 'The repository README documents an ISP renewal data fetcher and campaign dashboard with scheduled IMS portal data fetch, MySQL storage and sync, customer classification, a Flask UI/API, WhatsApp Cloud API integration, and operator audit logging. This is project evidence; it does not establish employment impact or stakeholder outcomes.',
  },
  {
    source: 'GitHub: Predictive-Analysis-on-Telecom-Customer-churn-A-Case-Study-on-AIRTEL (public repository)',
    excerpt: 'The repository README documents a telecom churn exploratory analysis and a logistic-regression risk simulator/dashboard in Streamlit, with contract, service, tenure, and payment-method filters. Model metrics should not be claimed unless separately verified.',
  },
  {
    source: 'GitHub: retail-promo-analysis (public repository)',
    excerpt: 'The repository README documents analysis of 1,500 promotional sales events across two festive campaigns, five promotion types, 50 stores, 10 cities, and 15 products, using Python, Pandas, NumPy, exploratory analysis, and an HTML/Chart.js dashboard. Treat reported percentages as project outputs, not employer results.',
  },
  {
    source: 'GitHub: Enterprise-Document-Intelligence-RAG-Platform (public repository)',
    excerpt: 'The repository README documents a RAG starter platform using FastAPI, Python ingestion and chunking, embeddings, FAISS vector search, OpenAI APIs, a Streamlit dashboard, token authentication and RBAC, Docker Compose, and an evaluation script. The README notes production identity and security hardening remains.',
  },
];
