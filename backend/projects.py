
import sqlite3
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/projects", tags=["Projects"])

DB_PATH = Path(__file__).resolve().parent / "data" / "annotations.db"


def get_db():
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_projects():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS projects (
                project_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS project_labels (
                project_id TEXT NOT NULL,
                label TEXT NOT NULL,
                PRIMARY KEY (project_id, label),
                FOREIGN KEY (project_id)
                    REFERENCES projects(project_id)
                    ON DELETE CASCADE
            )
        """)


initialize_projects()


class CreateProject(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class CreateLabel(BaseModel):
    label: str = Field(
        min_length=1,
        max_length=50,
        pattern=r"^[a-z][a-z0-9_-]*$",
    )


def validate_project_id(project_id: str):
    try:
        return str(UUID(project_id))
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="Invalid project ID",
        )


def require_project(db, project_id: str):
    project = db.execute(
        "SELECT * FROM projects WHERE project_id = ?",
        (project_id,),
    ).fetchone()

    if project is None:
        raise HTTPException(
            status_code=404,
            detail="Project not found",
        )

    return project


@router.post("", status_code=201)
def create_project(payload: CreateProject):
    name = payload.name.strip()

    if not name:
        raise HTTPException(
            status_code=422,
            detail="Project name cannot be empty",
        )

    project_id = str(uuid4())

    with get_db() as db:
        db.execute(
            """
            INSERT INTO projects (project_id, name)
            VALUES (?, ?)
            """,
            (project_id, name),
        )

    return {
        "project_id": project_id,
        "name": name,
        "labels": [],
    }


@router.get("")
def list_projects():
    with get_db() as db:
        projects = db.execute(
            """
            SELECT project_id, name, created_at
            FROM projects
            ORDER BY created_at, project_id
            """
        ).fetchall()

        result = []

        for project in projects:
            labels = db.execute(
                """
                SELECT label
                FROM project_labels
                WHERE project_id = ?
                ORDER BY label
                """,
                (project["project_id"],),
            ).fetchall()

            result.append({
                **dict(project),
                "labels": [row["label"] for row in labels],
            })

    return {"projects": result}


@router.get("/{project_id}")
def get_project(project_id: str):
    project_id = validate_project_id(project_id)

    with get_db() as db:
        project = require_project(db, project_id)

        labels = db.execute(
            """
            SELECT label
            FROM project_labels
            WHERE project_id = ?
            ORDER BY label
            """,
            (project_id,),
        ).fetchall()

        return {
            **dict(project),
            "labels": [row["label"] for row in labels],
        }


@router.post("/{project_id}/labels", status_code=201)
def add_project_label(project_id: str, payload: CreateLabel):
    project_id = validate_project_id(project_id)

    with get_db() as db:
        require_project(db, project_id)

        try:
            db.execute(
                """
                INSERT INTO project_labels (project_id, label)
                VALUES (?, ?)
                """,
                (project_id, payload.label),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(
                status_code=409,
                detail="Label already exists in this project",
            )

    return {
        "project_id": project_id,
        "label": payload.label,
        "status": "created",
    }


@router.delete("/{project_id}/labels/{label}")
def delete_project_label(project_id: str, label: str):
    project_id = validate_project_id(project_id)

    with get_db() as db:
        require_project(db, project_id)

        result = db.execute(
            """
            DELETE FROM project_labels
            WHERE project_id = ? AND label = ?
            """,
            (project_id, label),
        )

        if result.rowcount == 0:
            raise HTTPException(
                status_code=404,
                detail="Label not found",
            )

    return {"status": "deleted", "label": label}
