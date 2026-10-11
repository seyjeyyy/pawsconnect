create function public.submit_stray_report(p_actor_id uuid,p_report jsonb,p_photo_paths text[])
returns public.stray_reports language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.stray_reports; v_path text; begin
 foreach v_path in array p_photo_paths loop
  if p_actor_id is null or split_part(v_path,'/',1)<>p_actor_id::text or not exists(select 1 from storage.objects where bucket_id='rescue-evidence' and name=v_path) then raise exception 'Photo must be an uploaded file owned by this account' using errcode='42501'; end if;
 end loop;
 insert into public.stray_reports(user_id,animal_type,animal_count,description,condition,observed_at,province,city,barangay,latitude,longitude,address,reporter_contact,notes)
 values(p_actor_id,p_report->>'animal_type',(p_report->>'animal_count')::integer,p_report->>'description',p_report->>'condition',(p_report->>'observed_at')::timestamptz,p_report->>'province',p_report->>'city',coalesce(p_report->>'barangay',''),(p_report->>'latitude')::double precision,(p_report->>'longitude')::double precision,p_report->>'address',p_report->>'reporter_contact',p_report->>'notes') returning * into v;
 insert into public.stray_report_photos(report_id,storage_path) select v.id,unnest(p_photo_paths);
 return v;
end $$;
create function public.submit_adoption_application(p_actor_id uuid,p_pet_id uuid,p_motivation text,p_household jsonb,p_document_paths text[])
returns public.adoption_applications language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.adoption_applications; v_path text; begin
 foreach v_path in array p_document_paths loop
  if split_part(v_path,'/',1)<>p_actor_id::text or not exists(select 1 from storage.objects where bucket_id='adoption-documents' and name=v_path) then raise exception 'Document must be an uploaded file owned by this account' using errcode='42501'; end if;
 end loop;
 insert into public.adoption_applications(user_id,pet_id,motivation,household,document_paths) values(p_actor_id,p_pet_id,p_motivation,p_household,p_document_paths) returning * into v;
 update public.adopter_profiles set household=p_household,housing_type=p_household->>'housing_type',experience=p_household->>'pet_experience',consent_at=now(),updated_at=now() where user_id=p_actor_id;
 return v;
end $$;
create function public.save_assessment(p_actor_id uuid,p_answers jsonb,p_results jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v jsonb; begin
 insert into public.personality_assessments(user_id,answers,engine_version) values(p_actor_id,p_answers,'1.0.0') returning id into v_id;
 insert into public.personality_answers(assessment_id,question_key,answer) select v_id,key,value from jsonb_each(p_answers);
 for v in select * from jsonb_array_elements(p_results) loop
  insert into public.matching_results(assessment_id,pet_id,score,confidence,excluded,reasons,challenges,factors)
  values(v_id,(v->>'pet_id')::uuid,(v->>'score')::numeric,(v->>'confidence')::integer,(v->>'excluded')::boolean,v->'reasons',v->'challenges',v->'factors');
 end loop;
 return v_id;
end $$;
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.has_role(uuid,text[]),public.is_staff(),public.is_admin(),public.can_read_report(uuid),public.can_read_transport(uuid),public.check_service_eligibility(text,double precision,double precision) to anon,authenticated,service_role;
grant execute on all functions in schema public to service_role;
