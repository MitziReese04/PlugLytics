window.PLUGLYTICS_DEMO_DATA = {
  events: {
    student: [
      { date: "2026-11-24", time: "09:00", title: "Quiz: Data Structures and Algorithms", type: "deadline", courseCode: "MO-IT102" },
      { date: "2026-11-26", time: "13:00", title: "Database ERD assignment", type: "deadline", courseCode: "MO-IT107" },
      { date: "2026-11-30", time: "10:00", title: "Computer Networks lab", type: "class", courseCode: "MO-IT104" },
      { date: "2026-12-02", time: "14:00", title: "Academic advising meeting", type: "meeting" },
    ],
    instructor: [
      { date: "2026-11-23", time: "11:00", title: "Quiz review window", type: "class", courseCode: "COURSE-104" },
      { date: "2026-11-25", time: "17:00", title: "Assignment feedback due", type: "deadline", courseCode: "COURSE-104" },
      { date: "2026-11-30", time: "13:30", title: "Section A office hours", type: "meeting", courseCode: "COURSE-104" },
      { date: "2026-12-02", time: "09:00", title: "Attendance and progress review", type: "meeting" },
    ],
    admin: [
      { date: "2026-11-24", time: "10:00", title: "Term enrollment review", type: "meeting" },
      { date: "2026-11-27", time: "15:00", title: "Tuition reconciliation checkpoint", type: "deadline" },
      { date: "2026-12-02", time: "13:00", title: "Specialization capacity meeting", type: "meeting" },
      { date: "2026-12-04", time: "09:30", title: "Academic quality report review", type: "meeting" },
    ],
  },
  async loadCurriculum() {
    const response = await fetch("./demo-curriculum.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load the demo curriculum (HTTP ${response.status}).`);
    const curriculum = await response.json();
    const courses = curriculum.courses.map((course) => ({
      ...course,
      status: course.year === 1 ? "completed"
        : course.year === 2 && course.term === 1 ? "in_progress" : "remaining",
    }));
    const completedUnits = courses.reduce(
      (total, course) => total + (course.status === "completed" ? course.units : 0),
      0
    );
    return {
      ...curriculum,
      source: "demo_curriculum",
      courses,
      completedUnits,
      remainingUnits: Math.max(0, curriculum.totalUnits - completedUnits),
      completionPercent: curriculum.totalUnits
        ? Math.round((completedUnits / curriculum.totalUnits) * 100)
        : 0,
    };
  },
};
