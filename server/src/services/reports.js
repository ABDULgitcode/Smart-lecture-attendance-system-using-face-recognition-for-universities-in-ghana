import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';

function line(student) {
  return [
    student.name,
    student.indexNumber,
    student.present,
    student.late,
    student.absent,
    student.excused,
    student.percentage === null ? '' : student.percentage,
    student.eligible === null ? '' : student.eligible ? 'Yes' : 'No',
  ];
}

const HEADERS = ['Student', 'Index number', 'Present', 'Late', 'Absent', 'Excused', 'Attendance %', 'Exam eligible'];

export function buildPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const code = report.course?.code || 'Course';
    const title = report.course?.title || 'Attendance';
    doc.fontSize(18).text('Lecture attendance report');
    doc.moveDown(0.4);
    doc.fontSize(11).text(`${code} — ${title}`);
    doc.text(`${report.academicYear}, semester ${report.semester}`);
    doc.text(`Closed lectures: ${report.closedSessions}. Minimum attendance: ${report.minAttendancePercent}%`);
    doc.moveDown();
    doc.fontSize(9);
    for (const student of report.students) {
      const percent = student.percentage === null ? 'n/a' : `${student.percentage}%`;
      const eligible = student.eligible === null ? 'n/a' : student.eligible ? 'eligible' : 'below threshold';
      doc.text(
        `${student.name} (${student.indexNumber})  P${student.present} L${student.late} A${student.absent} E${student.excused}  ${percent}  ${eligible}`,
      );
    }
    if (!report.students.length) doc.text('No students are enrolled in this offering.');
    doc.end();
  });
}

export async function buildWorkbook(report) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Attendance');
  const code = report.course?.code || 'Course';
  const title = report.course?.title || 'Attendance';
  sheet.addRow([`${code} ${title}`]);
  sheet.addRow([`${report.academicYear} semester ${report.semester}`, `Minimum ${report.minAttendancePercent}%`]);
  sheet.addRow([]);
  sheet.addRow(HEADERS);
  for (const student of report.students) sheet.addRow(line(student));
  sheet.getRow(4).font = { bold: true };
  sheet.columns.forEach((column) => {
    column.width = 18;
  });
  return workbook.xlsx.writeBuffer();
}
