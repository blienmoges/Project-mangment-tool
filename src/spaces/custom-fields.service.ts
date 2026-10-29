import { Injectable } from '@nestjs/common';
import { CustomField, FieldType, Prisma } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { changedPositions, insertAt } from '../common/ordering';
import { randomToken } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { DropdownOption, dropdownOptions } from './custom-field-values';
import { CreateCustomFieldDto, DropdownOptionDto, UpdateCustomFieldDto } from './dto/space.dto';
import { SpaceAccessService } from './space-access.service';

type Tx = Prisma.TransactionClient;

/**
 * Custom task fields per space (SRS FR-11.5). Dropdown choices have stable ids, so a choice can be renamed
 * without touching tasks; tasks store the choice id. The field type cannot change after creation.
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaceAccess: SpaceAccessService,
    private readonly activity: ActivityService,
  ) {}

  async list(spaceId: string, userId: string) {
    await this.spaceAccess.requireSpace(spaceId, userId);
    const data = await this.prisma.customField.findMany({ where: { spaceId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return { data };
  }

  async create(spaceId: string, actorId: string, dto: CreateCustomFieldDto) {
    const { space } = await this.spaceAccess.requireSpaceAdmin(spaceId, actorId);
    const name = dto.name.trim();
    await this.ensureNameFree(spaceId, name);
    let options: DropdownOption[] | null = null;
    if (dto.fieldType === FieldType.dropdown) {
      if (!dto.options?.length) throw Errors.validation({ options: 'a dropdown field needs at least one choice' });
      options = this.normalizeOptions(dto.options, []);
    } else if (dto.options !== undefined) {
      throw Errors.validation({ options: 'only dropdown fields have choices' });
    }
    const current = await this.ordered(this.prisma, spaceId);
    const index = Math.min(dto.position ?? current.length, current.length);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.customField.create({
        data: { spaceId, name, fieldType: dto.fieldType, options: options ? (options as unknown as Prisma.InputJsonValue) : Prisma.DbNull, position: index },
      });
      await this.renumber(tx, insertAt(current, created, index));
      await this.activity.log(
        { workspaceId: space.workspaceId, actorId, entityType: 'custom_field', entityId: created.id, action: 'created', newValue: { spaceId, name, fieldType: dto.fieldType } },
        tx,
      );
      return tx.customField.findUniqueOrThrow({ where: { id: created.id } });
    });
  }

  /** Rename, reorder, or replace the dropdown choices. Task values that used a removed choice are cleared. */
  async update(fieldId: string, actorId: string, dto: UpdateCustomFieldDto) {
    const field = await this.findOrFail(fieldId);
    const { space } = await this.spaceAccess.requireSpaceAdmin(field.spaceId, actorId);
    const name = dto.name?.trim();
    if (name && name.toLowerCase() !== field.name.toLowerCase()) await this.ensureNameFree(field.spaceId, name, fieldId);

    let options: DropdownOption[] | undefined;
    let removedIds: string[] = [];
    if (dto.options !== undefined) {
      if (field.fieldType !== FieldType.dropdown) throw Errors.validation({ options: 'only dropdown fields have choices' });
      if (!dto.options.length) throw Errors.validation({ options: 'a dropdown field needs at least one choice' });
      const before = dropdownOptions(field);
      options = this.normalizeOptions(dto.options, before);
      removedIds = before.filter((o) => !options!.some((n) => n.id === o.id)).map((o) => o.id);
    }

    const current = await this.ordered(this.prisma, field.spaceId);
    const others = current.filter((f) => f.id !== fieldId);
    const index = dto.position !== undefined ? Math.min(dto.position, others.length) : current.findIndex((f) => f.id === fieldId);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.customField.update({
        where: { id: fieldId },
        data: { ...(name ? { name } : {}), ...(options ? { options: options as unknown as Prisma.InputJsonValue } : {}) },
      });
      let clearedValues = 0;
      if (removedIds.length) {
        const r = await tx.taskFieldValue.deleteMany({ where: { fieldId, OR: removedIds.map((id) => ({ value: { equals: id } })) } });
        clearedValues = r.count;
      }
      await this.renumber(tx, insertAt(others, updated, index));
      await this.activity.log(
        {
          workspaceId: space.workspaceId, actorId, entityType: 'custom_field', entityId: fieldId, action: 'updated',
          oldValue: { name: field.name, options: field.options ?? null } as Prisma.InputJsonValue,
          newValue: { name: updated.name, options: (options ?? field.options ?? null) as Prisma.InputJsonValue, clearedValues },
        },
        tx,
      );
      const result = await tx.customField.findUniqueOrThrow({ where: { id: fieldId } });
      return { ...result, clearedValues };
    });
  }

  /** Removes the field and its values on every task. */
  async remove(fieldId: string, actorId: string) {
    const field = await this.findOrFail(fieldId);
    const { space } = await this.spaceAccess.requireSpaceAdmin(field.spaceId, actorId);
    await this.prisma.$transaction(async (tx) => {
      const values = await tx.taskFieldValue.count({ where: { fieldId } });
      await tx.customField.delete({ where: { id: fieldId } }); // values are removed by ON DELETE CASCADE
      await this.renumber(tx, await this.ordered(tx, field.spaceId));
      await this.activity.log(
        { workspaceId: space.workspaceId, actorId, entityType: 'custom_field', entityId: fieldId, action: 'deleted', oldValue: { spaceId: field.spaceId, name: field.name, fieldType: field.fieldType, values } },
        tx,
      );
    });
  }

  // ───────────── helpers ─────────────

  private async findOrFail(fieldId: string) {
    const field = await this.prisma.customField.findUnique({ where: { id: fieldId } });
    if (!field) throw Errors.notFound('Custom field');
    return field;
  }

  private ordered(db: Tx | PrismaService, spaceId: string) {
    return db.customField.findMany({ where: { spaceId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  }

  private async renumber(tx: Tx, ordered: CustomField[]) {
    for (const c of changedPositions(ordered)) await tx.customField.update({ where: { id: c.id }, data: { position: c.to } });
  }

  /** Trims labels, rejects duplicates, keeps known ids and gives new choices an id. */
  private normalizeOptions(input: DropdownOptionDto[], existing: DropdownOption[]): DropdownOption[] {
    const labels = new Set<string>();
    const ids = new Set<string>();
    return input.map((o, i) => {
      const label = o.label.trim();
      if (!label) throw Errors.validation({ [`options.${i}.label`]: 'must not be empty' });
      if (labels.has(label.toLowerCase())) throw Errors.validation({ [`options.${i}.label`]: `"${label}" is listed twice` });
      labels.add(label.toLowerCase());
      if (o.id && !existing.some((e) => e.id === o.id)) throw Errors.validation({ [`options.${i}.id`]: 'is not a choice of this field; leave id out for new choices' });
      const id = o.id ?? randomToken(6);
      if (ids.has(id)) throw Errors.validation({ [`options.${i}.id`]: 'is listed twice' });
      ids.add(id);
      return { id, label, ...(o.color ? { color: o.color } : {}) };
    });
  }

  private async ensureNameFree(spaceId: string, name: string, exceptId?: string) {
    const clash = await this.prisma.customField.findFirst({
      where: { spaceId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (clash) throw Errors.conflict('ALREADY_EXISTS', 'This space already has a custom field with this name.');
  }
}
