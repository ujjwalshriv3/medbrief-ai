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
const __dirname = dirname(__filename);

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
  return text.replace(/\*\*(.*?)\*\*/g, "$1");
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
        `📄 Extracted text for ${file.originalname}:\n`,
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

    <b>Impression:</b>
    <one short paragraph>

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
          model: "llama3-70b-8192",
          messages: [
        {
          role: "system",
          content: `
    You are a helpful medical summarizer that outputs clean, well-formatted HTML with bold headings and lists.
    You are a medical report interpretation assistant.

    Your task is to read a patient’s medical report and produce a detailed, structured explanation that combines clinical accuracy with patient understanding.

    Follow these rules:

    1. **Tone & Style**
       - Professional but clear.
       - Avoid jargon where possible; when using medical terms, include a short explanation in parentheses.
       - Avoid fear-based wording unless results indicate a serious health risk.

    2. **Structure**
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
  
       - **Report Summary** → Mention the type of test, when it was done, and the laboratory.
       - **Key Findings** → List main results with values, units, and reference ranges.
       - **Interpretation** → Explain what each finding means in plain language.
       - **Possible Causes** → Include both medical and non-medical factors that may influence the results.
       - **Limitations** → Note any factors that might affect accuracy or require further tests.
       - **Suggest Next Steps** → Suggest follow-up actions or discussions with a healthcare provider.

    3. **Detail Level**
       - Always include <b>exact values</b> and <b>reference ranges</b>.
       - Mention whether results are normal, borderline, or abnormal.
       - Link each value to its possible health significance.

    4. **Readability**
       - Use short paragraphs or bullet points for clarity.
       - Keep sentences under 20 words when possible.
       - Preserve all formatting using HTML tags for headings, lists, and paragraphs.

    5. **Patient Context**
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
        { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
      );

      let summaryHTML =
        summaryRes.data?.choices?.[0]?.message?.content ||
        "No summary generated.";

      // Patient-friendly explanation as HTML bullet list
      const explainRes = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.3-70b-versatile",
          messages: [
            {
              role: "system",
              content: `You are an expert medical report explainer whose primary goal is to help patients understand their medical summaries in clear, simple language.  

              Your task is to take a medical report summary and rewrite it in a way that is easy for patients to understand.

              You must focus on the most important findings, potential risks, and recommended next steps, avoiding any complex medical terminology or jargon.

              Your explanations should be accessible to anyone, regardless of their medical background, and you must avoid technical jargon wherever possible. 

              If you must use a medical term, provide a brief explanation in parentheses so the patient can easily grasp its meaning. Focus on summarizing the most important findings, potential risks, and recommended next steps from the report, ensuring that each point is concise and easy to follow. 

              Present your output strictly as an HTML unordered list (<ul><li>...</li></ul>), containing exactly 4 to 6 bullet points. Each bullet should be a short, direct sentence no longer than 18 words, and should communicate the information in a friendly, reassuring manner. 
              Do not include any introductory or closing remarks, and do not add any text outside the list. 
              
              Your goal is to empower patients with clear, actionable information about their health in a format they can easily share or refer to.`,
            },
            {
              role: "user",
              content: `Rewrite this for a patient in short bullet points:\n${summaryHTML}`,
            },
          ],
        },
        { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
      );

      let explanation = explainRes.data?.choices?.[0]?.message?.content || "";
      explanation = removeMarkdownBold(explanation);

      // Merge into HTML with bullets like Suggested Next Steps
      const finalHTML = `
  <div style="font-family: Arial, sans-serif; line-height: 1.5;">
    ${summaryHTML}
    <b>Patient-Friendly Explanation:</b>
    ${explanation}
  </div>
`;

      // No PDF generation to disk - removed to avoid file storage
      // const pdfPath = await generatePDF(
      //   finalHTML,
      //   file.originalname.replace(/\.[^/.]+$/, "")
      // );
      // const pdfURL = `http://localhost:3001${pdfPath}`;

      patientSummaries.push({
        fileName: file.originalname,
        summary: finalHTML,
        // pdfLink: pdfURL, // Removed since no PDF is generated to disk
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
