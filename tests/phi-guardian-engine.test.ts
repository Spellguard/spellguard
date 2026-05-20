// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { BuiltinEngine } from '../packages/verifier/src/proxy/builtin-engine';
import type { PolicyEvalContext } from '../packages/verifier/src/proxy/policy-evaluator-types';

describe('BuiltinEngine - PHI Guardian', () => {
  const engine = new BuiltinEngine();

  function createContext(
    content: string,
    config: Record<string, unknown> = {},
  ): PolicyEvalContext {
    return {
      content,
      binding: {
        policyId: 'test-phi-guardian',
        policyType: 'phi-guardian',
        policySlug: 'test-phi-guardian',
        level: 'agent',
        effect: 'block',
        config,
      },
      direction: 'outbound',
    } as PolicyEvalContext;
  }

  describe('MRN detection', () => {
    it('should detect MRN followed by 6 digits', async () => {
      const ctx = createContext('Patient MRN 123456 was admitted.');
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThanOrEqual(1);
      const mrnDetection = detections.find((d) => d.type === 'phi-mrn');
      expect(mrnDetection).toBeDefined();
      expect(mrnDetection?.confidence).toBe(0.95);
    });

    it('should detect MRN followed by 10 digits', async () => {
      const ctx = createContext('Patient MRN 1234567890 was discharged.');
      const detections = await engine.evaluate(ctx);
      const mrnDetection = detections.find((d) => d.type === 'phi-mrn');
      expect(mrnDetection).toBeDefined();
      expect(mrnDetection?.confidence).toBe(0.95);
    });

    it('should detect MRN with colon separator', async () => {
      const ctx = createContext('MRN: 987654 needs follow-up.');
      const detections = await engine.evaluate(ctx);
      const mrnDetection = detections.find((d) => d.type === 'phi-mrn');
      expect(mrnDetection).toBeDefined();
    });

    it('should detect MRN with hash separator', async () => {
      const ctx = createContext('MRN#12345678 on file.');
      const detections = await engine.evaluate(ctx);
      const mrnDetection = detections.find((d) => d.type === 'phi-mrn');
      expect(mrnDetection).toBeDefined();
    });

    it('should detect "Medical Record Number" format', async () => {
      const ctx = createContext(
        'Medical Record Number 12345678 for the patient.',
      );
      const detections = await engine.evaluate(ctx);
      const mrnDetection = detections.find((d) => d.type === 'phi-mrn');
      expect(mrnDetection).toBeDefined();
    });

    it('should include PHI message for MRN', async () => {
      const ctx = createContext('MRN 123456 is on record.');
      const detections = await engine.evaluate(ctx);
      const mrnDetection = detections.find((d) => d.type === 'phi-mrn');
      expect(mrnDetection).toBeDefined();
      expect(mrnDetection?.message).toContain('Protected Health Information');
    });
  });

  describe('ICD-10 codes with medical context', () => {
    it('should detect ICD-10 code when "icd" is present', async () => {
      const ctx = createContext('ICD code E11.9 for diabetes diagnosis.');
      const detections = await engine.evaluate(ctx);
      const icdDetection = detections.find((d) => d.type === 'phi-icd10');
      expect(icdDetection).toBeDefined();
      expect(icdDetection?.confidence).toBe(0.85);
    });

    it('should detect ICD-10 code when "diagnosis" is present', async () => {
      const ctx = createContext('Diagnosis J45.0 was recorded.');
      const detections = await engine.evaluate(ctx);
      const icdDetection = detections.find((d) => d.type === 'phi-icd10');
      expect(icdDetection).toBeDefined();
    });

    it('should detect ICD-10 code when "code" is present', async () => {
      const ctx = createContext('The code M54.5 was assigned for back pain.');
      const detections = await engine.evaluate(ctx);
      const icdDetection = detections.find((d) => d.type === 'phi-icd10');
      expect(icdDetection).toBeDefined();
    });

    it('should NOT detect ICD-10-like patterns without medical context', async () => {
      const ctx = createContext('Product A12.3 is available in the warehouse.');
      const detections = await engine.evaluate(ctx);
      const icdDetection = detections.find((d) => d.type === 'phi-icd10');
      expect(icdDetection).toBeUndefined();
    });
  });

  describe('CPT codes with procedure context', () => {
    it('should detect CPT code when "cpt" is present', async () => {
      const ctx = createContext('CPT 99213 was billed for the visit.');
      const detections = await engine.evaluate(ctx);
      const cptDetection = detections.find((d) => d.type === 'phi-cpt');
      expect(cptDetection).toBeDefined();
      expect(cptDetection?.confidence).toBe(0.8);
    });

    it('should detect CPT code when "procedure" is present', async () => {
      const ctx = createContext('The procedure 27447 was completed.');
      const detections = await engine.evaluate(ctx);
      const cptDetection = detections.find((d) => d.type === 'phi-cpt');
      expect(cptDetection).toBeDefined();
    });

    it('should detect CPT code when "billing" is present', async () => {
      const ctx = createContext('Billing code 90837 for therapy session.');
      const detections = await engine.evaluate(ctx);
      const cptDetection = detections.find((d) => d.type === 'phi-cpt');
      expect(cptDetection).toBeDefined();
    });

    it('should NOT detect 5-digit numbers without procedure context', async () => {
      const ctx = createContext('The zip code is 90210 in Beverly Hills.');
      const detections = await engine.evaluate(ctx);
      const cptDetection = detections.find((d) => d.type === 'phi-cpt');
      expect(cptDetection).toBeUndefined();
    });
  });

  describe('NPI detection', () => {
    it('should detect NPI with prefix', async () => {
      const ctx = createContext('Provider NPI 1234567890 is registered.');
      const detections = await engine.evaluate(ctx);
      const npiDetection = detections.find((d) => d.type === 'phi-npi');
      expect(npiDetection).toBeDefined();
      expect(npiDetection?.confidence).toBe(0.9);
    });

    it('should detect NPI with colon separator', async () => {
      const ctx = createContext('NPI: 9876543210 on file.');
      const detections = await engine.evaluate(ctx);
      const npiDetection = detections.find((d) => d.type === 'phi-npi');
      expect(npiDetection).toBeDefined();
    });

    it('should detect standalone 10-digit number (NPI pattern)', async () => {
      const ctx = createContext(
        'The number 1234567890 is the provider identifier.',
      );
      const detections = await engine.evaluate(ctx);
      const npiDetection = detections.find((d) => d.type === 'phi-npi');
      expect(npiDetection).toBeDefined();
    });
  });

  describe('Medical keywords + dates', () => {
    it('should detect date with medical keyword "diagnosis"', async () => {
      const ctx = createContext('Diagnosis date: 01/15/2024.');
      const detections = await engine.evaluate(ctx);
      const dateDetection = detections.find(
        (d) => d.type === 'phi-medical-date',
      );
      expect(dateDetection).toBeDefined();
      expect(dateDetection?.confidence).toBe(0.75);
    });

    it('should detect date with medical keyword "admission"', async () => {
      const ctx = createContext('Admission on 03-20-2024.');
      const detections = await engine.evaluate(ctx);
      const dateDetection = detections.find(
        (d) => d.type === 'phi-medical-date',
      );
      expect(dateDetection).toBeDefined();
    });

    it('should detect date with medical keyword "surgery"', async () => {
      const ctx = createContext('Surgery scheduled for 12/25/24.');
      const detections = await engine.evaluate(ctx);
      const dateDetection = detections.find(
        (d) => d.type === 'phi-medical-date',
      );
      expect(dateDetection).toBeDefined();
    });

    it('should NOT detect dates without medical context', async () => {
      const ctx = createContext('The meeting is on 01/15/2024.');
      const detections = await engine.evaluate(ctx);
      const dateDetection = detections.find(
        (d) => d.type === 'phi-medical-date',
      );
      expect(dateDetection).toBeUndefined();
    });
  });

  describe('Medical keywords + dosages', () => {
    it('should detect dosage with medical keyword "prescribed"', async () => {
      const ctx = createContext('Patient prescribed 500mg daily.');
      const detections = await engine.evaluate(ctx);
      const dosageDetection = detections.find(
        (d) => d.type === 'phi-prescription-dosage',
      );
      expect(dosageDetection).toBeDefined();
      expect(dosageDetection?.confidence).toBe(0.8);
    });

    it('should detect dosage with tablet units', async () => {
      const ctx = createContext('Medication: 2 tablets twice daily.');
      const detections = await engine.evaluate(ctx);
      const dosageDetection = detections.find(
        (d) => d.type === 'phi-prescription-dosage',
      );
      expect(dosageDetection).toBeDefined();
    });

    it('should detect dosage in ml', async () => {
      const ctx = createContext('Treatment: administer 10 ml every 4 hours.');
      const detections = await engine.evaluate(ctx);
      const dosageDetection = detections.find(
        (d) => d.type === 'phi-prescription-dosage',
      );
      expect(dosageDetection).toBeDefined();
    });

    it('should detect dosage with named medication', async () => {
      const ctx = createContext('Patient takes metformin 500mg for diabetes.');
      const detections = await engine.evaluate(ctx);
      const dosageDetection = detections.find(
        (d) => d.type === 'phi-prescription-dosage',
      );
      expect(dosageDetection).toBeDefined();
    });

    it('should NOT detect dosage-like values without medical keywords', async () => {
      const ctx = createContext('The recipe calls for 500g of flour.');
      const detections = await engine.evaluate(ctx);
      const dosageDetection = detections.find(
        (d) => d.type === 'phi-prescription-dosage',
      );
      expect(dosageDetection).toBeUndefined();
    });
  });

  describe('minConfidence threshold config', () => {
    it('should filter detections below minConfidence', async () => {
      // Medical date has confidence 0.75, set threshold above that
      const ctx = createContext('Diagnosis date: 01/15/2024.', {
        minConfidence: 0.8,
      });
      const detections = await engine.evaluate(ctx);
      const dateDetection = detections.find(
        (d) => d.type === 'phi-medical-date',
      );
      expect(dateDetection).toBeUndefined();
    });

    it('should include detections at or above minConfidence', async () => {
      const ctx = createContext('MRN 123456 on file.', {
        minConfidence: 0.95,
      });
      const detections = await engine.evaluate(ctx);
      const mrnDetection = detections.find((d) => d.type === 'phi-mrn');
      expect(mrnDetection).toBeDefined();
    });

    it('should use default minConfidence of 0.7 when not specified', async () => {
      // medical-identifier has confidence 0.7, should be included by default
      const ctx = createContext('Patient diagnosis record 12345678 updated.');
      const detections = await engine.evaluate(ctx);
      const idDetection = detections.find(
        (d) => d.type === 'phi-medical-identifier',
      );
      expect(idDetection).toBeDefined();
      expect(idDetection?.confidence).toBe(0.7);
    });

    it('should exclude detections when minConfidence is set to 1.0', async () => {
      const ctx = createContext(
        'MRN 123456 on file. Diagnosis date: 01/15/2024.',
        { minConfidence: 1.0 },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('checkStructured: false config', () => {
    it('should skip MRN detection when checkStructured is false', async () => {
      const ctx = createContext('Patient MRN 123456 admitted.', {
        checkStructured: false,
      });
      const detections = await engine.evaluate(ctx);
      const mrnDetection = detections.find((d) => d.type === 'phi-mrn');
      expect(mrnDetection).toBeUndefined();
    });

    it('should skip ICD-10 detection when checkStructured is false', async () => {
      const ctx = createContext('ICD diagnosis code E11.9 recorded.', {
        checkStructured: false,
      });
      const detections = await engine.evaluate(ctx);
      const icdDetection = detections.find((d) => d.type === 'phi-icd10');
      expect(icdDetection).toBeUndefined();
    });

    it('should skip NPI detection when checkStructured is false', async () => {
      const ctx = createContext('NPI 1234567890 on file.', {
        checkStructured: false,
      });
      const detections = await engine.evaluate(ctx);
      const npiDetection = detections.find((d) => d.type === 'phi-npi');
      expect(npiDetection).toBeUndefined();
    });

    it('should still detect keyword-based PHI when checkStructured is false', async () => {
      const ctx = createContext('Patient prescribed 500mg daily.', {
        checkStructured: false,
      });
      const detections = await engine.evaluate(ctx);
      const dosageDetection = detections.find(
        (d) => d.type === 'phi-prescription-dosage',
      );
      expect(dosageDetection).toBeDefined();
    });
  });

  describe('checkKeywords: false config', () => {
    it('should skip date detection when checkKeywords is false', async () => {
      const ctx = createContext('Diagnosis date: 01/15/2024.', {
        checkKeywords: false,
      });
      const detections = await engine.evaluate(ctx);
      const dateDetection = detections.find(
        (d) => d.type === 'phi-medical-date',
      );
      expect(dateDetection).toBeUndefined();
    });

    it('should skip dosage detection when checkKeywords is false', async () => {
      const ctx = createContext('Patient prescribed 500mg daily.', {
        checkKeywords: false,
      });
      const detections = await engine.evaluate(ctx);
      const dosageDetection = detections.find(
        (d) => d.type === 'phi-prescription-dosage',
      );
      expect(dosageDetection).toBeUndefined();
    });

    it('should still detect structured identifiers when checkKeywords is false', async () => {
      const ctx = createContext('MRN 123456 on record.', {
        checkKeywords: false,
      });
      const detections = await engine.evaluate(ctx);
      const mrnDetection = detections.find((d) => d.type === 'phi-mrn');
      expect(mrnDetection).toBeDefined();
    });
  });

  describe('Non-medical content', () => {
    it('should not detect PHI in general conversation', async () => {
      const ctx = createContext(
        'Let us discuss the project timeline for next quarter.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not detect PHI in technical content', async () => {
      const ctx = createContext(
        'The API returns a JSON response with status 200.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not detect PHI in casual messages', async () => {
      const ctx = createContext('Hello! How are you doing today?');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty content', async () => {
      const ctx = createContext('');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should handle very short content', async () => {
      const ctx = createContext('Hi');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should detect multiple PHI types in one message', async () => {
      const ctx = createContext(
        'Patient MRN 123456 diagnosed with ICD code E11.9, prescribed 500mg metformin.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThanOrEqual(2);
      const types = detections.map((d) => d.type);
      expect(types).toContain('phi-mrn');
    });

    it('should handle both structured and keyword checks disabled', async () => {
      const ctx = createContext(
        'MRN 123456 patient prescribed 500mg metformin.',
        { checkStructured: false, checkKeywords: false },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });
});
