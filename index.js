import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import axios from "axios";
import Tesseract from "tesseract.js";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";
import dotenv from "dotenv";
dotenv.config();

// Resolve __dirname
const __filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

// PDF.js config
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.join(__dirname, "node_modules/pdfjs-dist/build/pdf.worker.mjs")
).href;

const app = express();
app.use(cors());
app.use(express.json());

// Multer setup - Changed to memory storage to avoid saving files to disk
const storage = multer.memoryStorage(); // Use memory storage instead of disk storage
const upload = multer({ storage });

// Remove markdown bold
function removeMarkdownBold(text) {
  return text.replace(/\\(.?)\\*/g, "$1");
}

app.post("/upload", upload.array("files", 10), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded." });
    }

    let patientSummaries = [];

    for (const file of files) {
      let extractedText = "";

      if (file.mimetype === "application/pdf") {
        // Convert buffer to Uint8Array for PDF processing
        const data = new Uint8Array(file.buffer);
        const pdf = await getDocument({ data }).promise;
        let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          fullText += content.items.map((item) => item.str).join(" ") + "\n";
        }
        extractedText = fullText.trim();
      } else if (file.mimetype.startsWith("image/")) {
        // Convert buffer to base64 for Tesseract processing
        const base64Image = file.buffer.toString('base64');
        const result = await Tesseract.recognize(Buffer.from(base64Image, 'base64'), "eng");
        extractedText = result.data.text;
      } else {
        extractedText = `Unsupported file type: ${file.originalname}`;
      }

      // No need to delete file since it's not saved to disk
      console.log(
        📄 Extracted text for ${file.originalname}:\n,
        extractedText
      );

      // AI prompt for clean Name: Value format
      const prompt = `

        <b>Patient Information:</b>
    <ul>
      <li><strong>Name:</strong></li>
      <li><strong>Age:</strong></li>
      <li><strong>Gender:</strong></li>
      <li><strong>Patient ID:</strong></li>
      <li><strong>Date of Admission:</strong></li>
      <li><strong>Date of Discharge:</strong></li>
      <li><strong>Hospital:</strong></li>
      <li><strong>Consultant:</strong></li>
    </ul>
    
    <b>Key Findings:</b>
    <ul>
    <li>Finding 1</li>
    <li>Finding 2</li>
    <li>Finding 3</li>
    </ul>

    Always format the Interpretation section as bullet points inside <ul><li> tags.
    Use simple, everyday language that a patient can easily understand.
    Avoid medical jargon (e.g., say “cancer cells” instead of “malignant epithelial cells”).
    Keep it short and clear, not more than 1–2 simple lines per point.
    <b>Interpretation:</b>
    <ul>
    <li>Point 1</li>
    <li>Point 2</li>
    <li>Point 3</li>
    </ul>

    <b>Possible Causes:</b>
    <ul>
    <li>Possible Causes 1</li>
    <li>Possible Causes 2</li>
    <li>Possible Causes 3</li>
    </ul>

    <b>Suggested Next Steps:</b>
    <ul>
    <li>Next Step 1</li>
    <li>Next Step 2</li>
    <li>Next Step 3</li>
    </ul>

    Report text:
    """
    ${extractedText}
    """
    `;

      const summaryRes = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.3-70b-versatile",
          messages: [
            {
              role: "system",
              content: `
    You are a helpful medical summarizer that outputs clean, well-formatted HTML with bold headings and lists.
    You are a medical report interpretation assistant.

    Your task is to read a patient’s medical report and produce a detailed, structured explanation that combines clinical accuracy with patient understanding.

    When outputting section headings like "Report Summary:", "Key Findings:", 
    "Interpretation:", "Possible Causes:", "Suggested Next Steps:", 
    "Overall Health Status:", and "Patient-Friendly Explanation:", 
    always wrap them inside <p><b> ... </b></p> instead of just <b> ... </b>.

    Follow these rules:

    1. *Tone & Style*
       - Professional but clear.
       - Avoid jargon where possible; when using medical terms, include a short explanation in parentheses.
       - Avoid fear-based wording unless results indicate a serious health risk.

    2. *Structure*
       - Use HTML <b>bold headings</b> for each section.
       - Use <ul><li>...</li></ul> for lists where appropriate.
         <b>Patient Information:</b>
         
      <strong>Name:</strong>
      <strong>Age:</strong>
      <strong>Gender:</strong>
      <strong>Patient ID:</strong>
      <strong>Date of Admission:</strong>
      <strong>Date of Discharge:</strong>
      <strong>Hospital:</strong>
      <strong>Consultant:</strong>
  
       - *Report Summary* → Mention the type of test, when it was done, and the laboratory.
       - *Key Findings* → List main results with values, units, and reference ranges.
       - *Interpretation* → Explain what each finding means in plain and human language.
       - *Possible Causes* → Include both medical and non-medical factors that may influence the results.
       - *Suggested Next Steps* → Suggest follow-up actions or discussions with a healthcare provider.

    3. *Detail Level*
       - Always include <b>exact values</b> and <b>reference ranges</b>.
       - Mention whether results are normal, borderline, or abnormal.
       - Link each value to its possible health significance.

    4. *Readability*
       - Use short paragraphs or bullet points for clarity.
       - Keep sentences under 20 words when possible.
       - Preserve all formatting using HTML tags for headings, lists, and paragraphs.

    5. *Patient Context*
       - Relate findings to the patient’s health and potential future risks.
       - Provide a concise summary of the overall health status at the end.

    Your goal: Deliver an explanation that retains full medical precision, includes methodology and reference ranges, and is understandable for an educated patient. Output must be well-formatted HTML.
          `,
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 2048,
        },
        { headers: { Authorization: Bearer ${process.env.GROQ_API_KEY} } }
      );

      let summaryHTML =
        summaryRes.data?.choices?.[0]?.message?.content ||
        "No summary generated.";

      summaryHTML = summaryHTML.replace(/<b>(.*?)<\/b>/g, "<p><b>$1</b></p>");
      summaryHTML = summaryHTML.replace(/<p><b>Patient-Friendly Explanation:.*$/s, "");

      // Patient-friendly explanation as HTML bullet list
      const explainRes = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.3-70b-versatile",
          messages: [
            {
              role: "system",
              content: `You are a medical explainer. Your job is to rewrite the medical report in simple, patient-friendly language.  

Rules:  
- Avoid ALL medical jargon. If you must use a medical term (like biopsy, chemotherapy), give a very short, plain explanation in brackets. Example: “biopsy (a small tissue test)”.  
- Keep every sentence short and clear (maximum 15 words).  
- Use a warm, reassuring tone.  
- Focus only on what the patient needs to know: diagnosis, stage (if any), spread/no spread, treatment steps, and follow-up importance.  
- Never include lab terms like BI-RADS, hypoechoic, epithelial, ER+/PR+, or HER2 — instead use “tests show cancer is present” or “cancer responds to hormones.”  
- Do not include hospital technicalities (like CT, MRI, margins). Translate them to “scan” or “imaging test.”  
- Output strictly as an HTML unordered list (<ul><li>...</li></ul>), with 4–6 bullet points.  
- Each bullet must be simple, friendly, and less than 18 words.  
- No introduction or conclusion, only the list.  

Your goal: make the report so clear that even someone with zero medical background understands it fully.`,
            },
            {
              role: "user",
              content: Rewrite this for a patient in short bullet points:\n${summaryHTML},
            },
          ],
        },
        { headers: { Authorization: Bearer ${process.env.GROQ_API_KEY} } }
      );

      let explanation = explainRes.data?.choices?.[0]?.message?.content || "";
      explanation = removeMarkdownBold(explanation);

      const finalHTML = `
  <div style="font-family: Arial, sans-serif; line-height: 1.5;">
    ${summaryHTML}
    <p><b>Patient-Friendly Explanation:</b></p>
    ${explanation}
  </div>
`;

      patientSummaries.push({
        fileName: file.originalname,
        summary: finalHTML,
      });
    }

    res.json({ summaries: patientSummaries });
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: "Failed to process files",
      details: err.response?.data || err.message,
    });
  }
});

app.listen(3001, () => {
  console.log("✅ Backend running on http://localhost:3001");
});
