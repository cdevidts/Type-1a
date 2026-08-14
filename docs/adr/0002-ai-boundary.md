# ADR 0002: AI interprets; deterministic code calculates

Status: accepted

Abacus RouteLLM is used for visual food estimation and descriptive language. Zod schemas validate structured output. Application code computes totals, correction math, timestamps, glucose freshness, and Meal Episode metrics.

The model must never calculate or recommend insulin, infer a therapy parameter, or turn estimated carbohydrates into confirmed carbohydrates.
